import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { ErrorBody, SafeFetchError, type SafeFetchOptions, type SafeFetchResponse, type safeFetch } from "@sg/shared";
import { createApp } from "../app.js";
import type { Config } from "../config.js";
import { hashToken } from "../lib/credential.js";
import { createSupabase } from "../lib/supabase.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const supabase = createSupabase(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const createdOrigins: string[] = [];
const usedIps: string[] = [];

afterAll(async () => {
  await pool.query(
    "delete from rate_limits where key in (select 'sites-rotate:' || id from websites where origin = any($1))",
    [createdOrigins],
  );
  await pool.query("delete from websites where origin = any($1)", [createdOrigins]);
  await pool.query("delete from registration_challenges where origin = any($1)", [createdOrigins]);
  await pool.query("delete from rate_limits where split_part(key, ':', 2) = any($1)", [usedIps]);
  await pool.end();
});

const baseConfig: Config = {
  SUPABASE_URL: process.env.SUPABASE_URL!,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  DATABASE_URL: process.env.DATABASE_URL!,
  ANTHROPIC_API_KEY: "unused",
  CORE_PUBLIC_URL: "http://localhost:8787",
  PORT: 8787,
  ANTHROPIC_MODEL: "claude-opus-5-5",
  ALLOW_LOCAL_SITES: false,
  AI_STUB: false,
  // Tests give every case its own client IP via X-Forwarded-For so the real
  // Postgres-backed per-IP limiters never interfere between cases.
  TRUST_PROXY: 1,
  CORS_ALLOWED_ORIGINS: [],
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
};

type Fetcher = typeof safeFetch;
type Call = { url: string; opts: SafeFetchOptions | undefined };

function ok(body: string, status = 200): SafeFetchResponse {
  return { status, finalUrl: "", headers: {}, body, truncated: false };
}

/** Stub that answers the verify URLs via `respond`, recording every call. */
function stubFetcher(respond: (url: string) => SafeFetchResponse | Error) {
  const calls: Call[] = [];
  const fetcher = ((url: string, opts?: SafeFetchOptions) => {
    calls.push({ url, opts });
    const r = respond(url);
    if (r instanceof Error) return Promise.reject(r);
    return Promise.resolve({ ...r, finalUrl: r.finalUrl || url });
  }) as Fetcher;
  return { fetcher, calls };
}

let ip = "";
beforeEach(() => {
  const b = randomBytes(3);
  ip = `10.${b[0]}.${b[1]}.${b[2]}`;
  usedIps.push(ip);
});

function build(opts: { fetcher?: Fetcher; now?: () => Date; config?: Partial<Config> } = {}) {
  return createApp({
    config: { ...baseConfig, ...opts.config },
    supabase,
    pool,
    ai: { reply: () => Promise.reject(new Error("unused")) },
    fetcher: opts.fetcher ?? stubFetcher(() => new SafeFetchError("network_error", "x")).fetcher,
    now: opts.now,
    queue: { enqueueLinkScan: () => Promise.reject(new Error("unused")), stop: () => Promise.resolve() },
  });
}

function newOrigin(): string {
  const o = `https://t-${randomUUID()}.example.com`;
  createdOrigins.push(o);
  return o;
}

/** A per-test "site": the stub serves whichever challenge the latest start returned. */
function site(origin: string, mode: "rest" | "fallback" = "rest") {
  const served = new Map<string, string>();
  const { fetcher, calls } = stubFetcher((url) => {
    const rest = /\/wp-json\/site-guardian\/v1\/verify\/([0-9a-f-]+)$/.exec(url);
    const fb = /\/\?site_guardian_verify=([0-9a-f-]+)$/.exec(url);
    if (!url.startsWith(origin)) return ok("nope", 404);
    if (rest && mode === "rest") {
      const v = served.get(rest[1]!);
      return v ? ok(JSON.stringify({ challenge: v })) : ok("{}", 404);
    }
    if (fb && mode === "fallback") {
      const v = served.get(fb[1]!);
      return v ? ok(JSON.stringify({ challenge: v })) : ok("{}", 404);
    }
    return ok("<html>not found</html>", 404);
  });
  return { fetcher, calls, served };
}

async function start(app: ReturnType<typeof build>, body: Record<string, unknown>) {
  return request(app).post("/api/v1/sites/register/start").set("X-Forwarded-For", ip).send(body);
}
async function complete(app: ReturnType<typeof build>, challenge_id: string) {
  return request(app).post("/api/v1/sites/register/complete").set("X-Forwarded-For", ip).send({ challenge_id });
}

/** Full start + complete against a stub that serves the challenge correctly. */
async function register(origin: string, installation_id: string = randomUUID()) {
  const s = site(origin);
  const app = build({ fetcher: s.fetcher });
  const st = await start(app, { installation_id, site_url: `${origin}/`, site_name: "Test" });
  expect(st.status).toBe(201);
  s.served.set(st.body.challenge_id, st.body.challenge);
  const res = await complete(app, st.body.challenge_id);
  return { res, app, calls: s.calls };
}

async function auditActions(websiteId: string): Promise<{ action: string; metadata: Record<string, unknown> }[]> {
  const r = await pool.query("select action, metadata from audit_logs where website_id = $1 order by created_at", [websiteId]);
  return r.rows;
}

describe("sites: register/start", () => {
  it("returns 201 with a challenge; DB stores only the hash; expires in 10 minutes", async () => {
    const origin = newOrigin();
    const fixed = new Date("2030-01-01T00:00:00.000Z");
    const app = build({ now: () => fixed });
    const res = await start(app, { installation_id: randomUUID(), site_url: `${origin}/?x=1` });
    expect(res.status).toBe(201);
    expect(res.body.challenge_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(typeof res.body.challenge).toBe("string");
    expect(res.body.challenge.length).toBeGreaterThanOrEqual(32);
    expect(res.body.expires_at).toBe("2030-01-01T00:10:00.000Z");

    const row = (await pool.query("select * from registration_challenges where id = $1", [res.body.challenge_id])).rows[0];
    expect(row.origin).toBe(origin);
    expect(row.challenge_hash).toBe(hashToken(res.body.challenge));
    expect(JSON.stringify(row)).not.toContain(res.body.challenge);
    expect(new Date(row.expires_at).toISOString()).toBe("2030-01-01T00:10:00.000Z");
    expect(row.used_at).toBeNull();
  });

  it("rejects an invalid body with 400 bad_request", async () => {
    const res = await start(build(), { installation_id: "nope", site_url: "https://a.example.com" });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("bad_request");
    expect(ErrorBody.safeParse(res.body).success).toBe(true);
  });

  it.each([
    "http://localhost:8080",
    "http://wp.localhost",
    "http://mysite.local",
    "http://svc.internal",
    "http://box.lan",
    "http://127.0.0.1",
    "http://[::1]",
    "https://example.com..",
    "ftp://example.com",
  ])("ALLOW_LOCAL_SITES=false rejects %s with 400", async (site_url) => {
    const res = await start(build(), { installation_id: randomUUID(), site_url });
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("bad_request");
  });

  // Identity and verification are origin-only: a sub-folder install would be verified at the
  // origin root (wrong WordPress, or a takeover of the origin's row by one path's owner).
  it.each(["https://example.com/blog", "https://example.com/blog/", "https://example.com/~alice/wp"])(
    "rejects a sub-folder site_url %s with 400 and a clear message",
    async (site_url) => {
      const res = await start(build(), { installation_id: randomUUID(), site_url });
      expect(res.status).toBe(400);
      expect(res.body.error.code).toBe("bad_request");
      expect(res.body.error.message).toMatch(/sub-folder/i);
    },
  );

  it.each(["https://Example.COM:443/", "https://example.com", "https://example.com/?lang=en"])(
    "accepts a root site_url %s",
    async (site_url) => {
      createdOrigins.push("https://example.com");
      const res = await start(build(), { installation_id: randomUUID(), site_url });
      expect(res.status).toBe(201);
    },
  );

  it("ALLOW_LOCAL_SITES=true accepts http://localhost:8080", async () => {
    createdOrigins.push("http://localhost:8080");
    const res = await start(build({ config: { ALLOW_LOCAL_SITES: true } }), {
      installation_id: randomUUID(),
      site_url: "http://localhost:8080",
    });
    expect(res.status).toBe(201);
  });

  it("the 21st start from one IP within the hour -> 429 rate_limited", async () => {
    const app = build();
    const body = { installation_id: randomUUID(), site_url: newOrigin() };
    for (let i = 0; i < 20; i++) expect((await start(app, body)).status).toBe(201);
    const res = await start(app, body);
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("rate_limited");
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
  });
});

describe("sites: register/complete", () => {
  it("issues a credential; stores only its hash; creates website, credit balance and audit rows", async () => {
    const origin = newOrigin();
    const installation = randomUUID();
    const { res, calls } = await register(origin, installation);
    expect(res.status).toBe(201);
    expect(res.body.credential).toMatch(/^sgat_[0-9a-f]{64}$/);
    expect(res.body.plan_code).toBe("free");

    expect(calls[0]!.url).toMatch(new RegExp(`^${origin}/wp-json/site-guardian/v1/verify/[0-9a-f-]{36}$`));
    expect(calls[0]!.opts).toMatchObject({ timeoutMs: 10000, maxBytes: 4096, allowPrivate: false, allowedPorts: [80, 443] });

    const w = (await pool.query("select * from websites where id = $1", [res.body.website_id])).rows[0];
    expect(w.origin).toBe(origin);
    expect(w.installation_id).toBe(installation);
    expect(w.status).toBe("active");
    expect(w.credential_hash).toBe(hashToken(res.body.credential));
    expect(JSON.stringify(w)).not.toContain(res.body.credential);
    expect(res.body.credential.startsWith(w.credential_prefix)).toBe(true);

    const bal = await pool.query("select balance from credit_balances where website_id = $1", [res.body.website_id]);
    expect(bal.rows).toEqual([{ balance: 0 }]);
    const actions = await auditActions(res.body.website_id);
    expect(actions.map((a) => a.action)).toContain("site.registered");
    expect(JSON.stringify(actions)).not.toContain(res.body.credential);
  });

  it("wrong challenge value -> 400 verification_failed, no website row", async () => {
    const origin = newOrigin();
    const s = site(origin);
    const app = build({ fetcher: s.fetcher });
    const st = await start(app, { installation_id: randomUUID(), site_url: origin });
    s.served.set(st.body.challenge_id, "wrong-value");
    const res = await complete(app, st.body.challenge_id);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("verification_failed");
    expect(JSON.stringify(res.body)).not.toContain("wrong-value");
    expect((await pool.query("select 1 from websites where origin = $1", [origin])).rowCount).toBe(0);
    const audits = await pool.query(
      "select metadata from audit_logs where action = 'site.verification_failed' and metadata->>'origin' = $1",
      [origin],
    );
    expect(audits.rowCount).toBe(1);
    expect(audits.rows[0].metadata.reason).toBe("mismatch");
  });

  it("REST URL 404 and fallback URL correct -> success", async () => {
    const origin = newOrigin();
    const s = site(origin, "fallback");
    const app = build({ fetcher: s.fetcher });
    const st = await start(app, { installation_id: randomUUID(), site_url: origin });
    s.served.set(st.body.challenge_id, st.body.challenge);
    const res = await complete(app, st.body.challenge_id);
    expect(res.status).toBe(201);
    expect(s.calls.map((c) => c.url)).toEqual([
      `${origin}/wp-json/site-guardian/v1/verify/${st.body.challenge_id}`,
      `${origin}/?site_guardian_verify=${st.body.challenge_id}`,
    ]);
  });

  it("correct body but redirected to another host -> 400 verification_failed, audit redirected_off_origin", async () => {
    const origin = newOrigin();
    let value = "";
    const { fetcher, calls } = stubFetcher(() => ({
      ...ok(JSON.stringify({ challenge: value })),
      finalUrl: "https://forwarder.example.net/anything",
    }));
    const app = build({ fetcher });
    const st = await start(app, { installation_id: randomUUID(), site_url: origin });
    value = st.body.challenge;
    const res = await complete(app, st.body.challenge_id);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("verification_failed");
    expect(calls).toHaveLength(2);
    expect((await pool.query("select 1 from websites where origin = $1", [origin])).rowCount).toBe(0);
    const audits = await pool.query(
      "select metadata from audit_logs where action = 'site.verification_failed' and metadata->>'origin' = $1",
      [origin],
    );
    expect(audits.rows.map((r) => r.metadata.reason)).toEqual(["redirected_off_origin"]);
  });

  it.each([
    ["www toggle", (h: string) => `https://www.${h}/x`],
    ["different port", (h: string) => `https://${h}:8443/x`],
    ["subdomain-suffix trick", (h: string) => `https://${h}.evil.example.net/x`],
  ])("redirect off origin (%s) is rejected", async (_name, final) => {
    const origin = newOrigin();
    const host = new URL(origin).hostname;
    let value = "";
    const { fetcher } = stubFetcher(() => ({ ...ok(JSON.stringify({ challenge: value })), finalUrl: final(host) }));
    const app = build({ fetcher });
    const st = await start(app, { installation_id: randomUUID(), site_url: origin });
    value = st.body.challenge;
    const res = await complete(app, st.body.challenge_id);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("verification_failed");
  });

  it("same-host http -> https redirect is accepted", async () => {
    const httpsOrigin = newOrigin();
    const host = new URL(httpsOrigin).hostname;
    const origin = `http://${host}`;
    createdOrigins.push(origin);
    let value = "";
    const { fetcher } = stubFetcher((url) => ({
      ...ok(JSON.stringify({ challenge: value })),
      finalUrl: url.replace("http://", "https://"),
    }));
    const app = build({ fetcher });
    const st = await start(app, { installation_id: randomUUID(), site_url: origin });
    value = st.body.challenge;
    const res = await complete(app, st.body.challenge_id);
    expect(res.status).toBe(201);
  });

  it("replay: a second complete with the same challenge_id -> 400 verification_failed", async () => {
    const origin = newOrigin();
    const s = site(origin);
    const app = build({ fetcher: s.fetcher });
    const st = await start(app, { installation_id: randomUUID(), site_url: origin });
    s.served.set(st.body.challenge_id, st.body.challenge);
    expect((await complete(app, st.body.challenge_id)).status).toBe(201);
    const again = await complete(app, st.body.challenge_id);
    expect(again.status).toBe(400);
    expect(again.body.error.code).toBe("verification_failed");
  });

  it("concurrent completes with one challenge: exactly one wins", async () => {
    const origin = newOrigin();
    const s = site(origin);
    const app = build({ fetcher: s.fetcher });
    const st = await start(app, { installation_id: randomUUID(), site_url: origin });
    s.served.set(st.body.challenge_id, st.body.challenge);
    const results = await Promise.all([complete(app, st.body.challenge_id), complete(app, st.body.challenge_id)]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 400]);
  });

  it("expired: `now` advanced by 11 min -> 400 verification_failed", async () => {
    // The consume check uses the database clock (expires_at > now()). To expire the
    // challenge we issue it with an injected `now` 11 minutes in the past, so its
    // expires_at (issued + 10 min) is already one minute behind the DB clock.
    const origin = newOrigin();
    const s = site(origin);
    const elevenMinAgo = new Date(Date.now() - 11 * 60_000);
    const st = await start(build({ fetcher: s.fetcher, now: () => elevenMinAgo }), {
      installation_id: randomUUID(),
      site_url: origin,
    });
    expect(st.status).toBe(201);
    s.served.set(st.body.challenge_id, st.body.challenge);
    const res = await complete(build({ fetcher: s.fetcher }), st.body.challenge_id);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("verification_failed");
    expect(s.calls).toHaveLength(0);
  });

  it("unknown challenge_id -> 400 verification_failed", async () => {
    const res = await complete(build(), randomUUID());
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("verification_failed");
  });

  it("fetcher throws blocked_address -> 400 verification_failed mentioning the site couldn't be reached", async () => {
    const origin = newOrigin();
    const { fetcher, calls } = stubFetcher(() => new SafeFetchError("blocked_address", "10.0.0.1 is private"));
    const app = build({ fetcher });
    const st = await start(app, { installation_id: randomUUID(), site_url: origin });
    const res = await complete(app, st.body.challenge_id);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("verification_failed");
    expect(res.body.error.message).toMatch(/couldn't be reached/i);
    expect(res.body.error.message).not.toContain("10.0.0.1");
    expect(calls).toHaveLength(2);
  });

  it("same origin + same installation re-verified -> 200, same website_id, old token now 401", async () => {
    const origin = newOrigin();
    const installation = randomUUID();
    const first = await register(origin, installation);
    expect(first.res.status).toBe(201);
    const second = await register(origin, installation);
    expect(second.res.status).toBe(200);
    expect(second.res.body.website_id).toBe(first.res.body.website_id);
    expect(second.res.body.credential).not.toBe(first.res.body.credential);

    const app = build();
    const old = await request(app).get("/api/v1/config").set("Authorization", `Bearer ${first.res.body.credential}`);
    expect(old.status).toBe(401);
    const cur = await request(app).get("/api/v1/config").set("Authorization", `Bearer ${second.res.body.credential}`);
    expect(cur.status).toBe(200);
  });

  it("same origin + different installation -> 200, same website_id, audit site.credential_rotated", async () => {
    const origin = newOrigin();
    const first = await register(origin, randomUUID());
    const newInstall = randomUUID();
    const second = await register(origin, newInstall);
    expect(second.res.status).toBe(200);
    expect(second.res.body.website_id).toBe(first.res.body.website_id);
    const w = (await pool.query("select installation_id from websites where id = $1", [first.res.body.website_id])).rows[0];
    expect(w.installation_id).toBe(newInstall);
    const actions = await auditActions(first.res.body.website_id);
    expect(actions.map((a) => a.action)).toEqual(["site.registered", "site.credential_rotated"]);
    expect(actions[1]!.metadata).toMatchObject({ via: "register", installation_changed: true });
  });

  it("new origin, same installation -> a new website_id", async () => {
    const installation = randomUUID();
    const a = await register(newOrigin(), installation);
    const b = await register(newOrigin(), installation);
    expect(a.res.status).toBe(201);
    expect(b.res.status).toBe(201);
    expect(b.res.body.website_id).not.toBe(a.res.body.website_id);
  });

  it.each(["suspended", "revoked"])("re-registration of a %s site -> 403, row unchanged", async (status) => {
    const origin = newOrigin();
    const first = await register(origin);
    await pool.query("update websites set status = $2 where id = $1", [first.res.body.website_id, status]);
    const second = await register(origin);
    expect(second.res.status).toBe(403);
    expect(second.res.body.error.code).toBe("forbidden");
    const w = (await pool.query("select status, credential_hash from websites where id = $1", [first.res.body.website_id]))
      .rows[0];
    expect(w.status).toBe(status);
    expect(w.credential_hash).toBe(hashToken(first.res.body.credential));
  });

  it("ALLOW_LOCAL_SITES=true: fetcher gets allowPrivate and the origin's port", async () => {
    const origin = "http://localhost:8089";
    createdOrigins.push(origin);
    const s = site(origin);
    const app = build({ fetcher: s.fetcher, config: { ALLOW_LOCAL_SITES: true } });
    const st = await start(app, { installation_id: randomUUID(), site_url: origin });
    s.served.set(st.body.challenge_id, st.body.challenge);
    const res = await complete(app, st.body.challenge_id);
    expect([200, 201]).toContain(res.status);
    expect(s.calls[0]!.opts).toMatchObject({ allowPrivate: true });
    expect(s.calls[0]!.opts?.allowedPorts).toContain(8089);
  });
});

describe("sites: credential rotate", () => {
  it("valid bearer -> new token; old one 401; audited", async () => {
    const { res } = await register(newOrigin());
    const app = build();
    const rot = await request(app).post("/api/v1/sites/credential/rotate").set("Authorization", `Bearer ${res.body.credential}`);
    expect(rot.status).toBe(200);
    expect(rot.body.credential).toMatch(/^sgat_[0-9a-f]{64}$/);
    expect(rot.body.credential).not.toBe(res.body.credential);
    const old = await request(app).get("/api/v1/config").set("Authorization", `Bearer ${res.body.credential}`);
    expect(old.status).toBe(401);
    const cur = await request(app).get("/api/v1/config").set("Authorization", `Bearer ${rot.body.credential}`);
    expect(cur.status).toBe(200);
    const actions = await auditActions(res.body.website_id);
    expect(actions.at(-1)).toMatchObject({ action: "site.credential_rotated", metadata: { via: "rotate" } });
  });

  it("without a bearer -> 401", async () => {
    const rot = await request(build()).post("/api/v1/sites/credential/rotate");
    expect(rot.status).toBe(401);
    expect(rot.body.error.code).toBe("unauthorized");
  });

  it("the 11th rotate for one website within the hour -> 429", async () => {
    const { res } = await register(newOrigin());
    const app = build();
    let token: string = res.body.credential;
    for (let i = 0; i < 10; i++) {
      const r = await request(app).post("/api/v1/sites/credential/rotate").set("Authorization", `Bearer ${token}`);
      expect(r.status).toBe(200);
      token = r.body.credential;
    }
    const r = await request(app).post("/api/v1/sites/credential/rotate").set("Authorization", `Bearer ${token}`);
    expect(r.status).toBe(429);
  });
});

describe("GET /config", () => {
  it("valid site -> 200 with remote config and its website id", async () => {
    const { res } = await register(newOrigin());
    const cfg = await request(build()).get("/api/v1/config").set("Authorization", `Bearer ${res.body.credential}`);
    expect(cfg.status).toBe(200);
    expect(cfg.body.website).toEqual({ id: res.body.website_id, status: "active" });
    expect(cfg.body.config).toMatchObject({ maintenance_mode: false, min_plugin_version: "0.1.0" });
  });

  it("revoked site -> 403", async () => {
    const { res } = await register(newOrigin());
    await pool.query("update websites set status = 'revoked' where id = $1", [res.body.website_id]);
    const cfg = await request(build()).get("/api/v1/config").set("Authorization", `Bearer ${res.body.credential}`);
    expect(cfg.status).toBe(403);
    expect(cfg.body.error.code).toBe("forbidden");
  });
});
