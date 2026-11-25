import { randomUUID } from "node:crypto";
import pg from "pg";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { ErrorBody, SafeFetchError, ScanResultsResponse, ScanStatus } from "@sg/shared";
import { createApp } from "../app.js";
import type { Config } from "../config.js";
import { generateCredential } from "../lib/credential.js";
import type { JobQueue } from "../lib/queue.js";
import { sweepStaleStarting } from "../lib/scan-store.js";
import { createSupabase } from "../lib/supabase.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const supabase = createSupabase(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const siteIds: string[] = [];

afterAll(async () => {
  await pool.query("delete from rate_limits where split_part(key, ':', 2) = any($1)", [siteIds]);
  await pool.query("delete from websites where id = any($1)", [siteIds]); // cascades scans, pages, results
  await pool.end();
});

const config: Config = {
  SUPABASE_URL: process.env.SUPABASE_URL!,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  DATABASE_URL: process.env.DATABASE_URL!,
  ANTHROPIC_API_KEY: "unused",
  CORE_PUBLIC_URL: "http://localhost:8787",
  PORT: 8787,
  ANTHROPIC_MODEL: "claude-opus-5-5",
  ALLOW_LOCAL_SITES: false,
  AI_STUB: false,
  TRUST_PROXY: 0,
  CORS_ALLOWED_ORIGINS: [],
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
};

function fakeQueue() {
  const enqueued: string[] = [];
  const queue: JobQueue = {
    enqueueLinkScan: (scanId) => {
      enqueued.push(scanId);
      return Promise.resolve(randomUUID());
    },
    stop: () => Promise.resolve(),
  };
  return { queue, enqueued };
}

function build(opts: { queue?: JobQueue; now?: () => Date; config?: Partial<Config> } = {}) {
  return createApp({
    config: { ...config, ...opts.config },
    supabase,
    pool,
    ai: { reply: () => Promise.reject(new Error("unused")) },
    fetcher: () => Promise.reject(new SafeFetchError("network_error", "x")),
    queue: opts.queue ?? fakeQueue().queue,
    now: opts.now,
  });
}

async function newSite(origin = `https://scan-${randomUUID()}.example.com`) {
  const cred = generateCredential();
  const { rows } = await pool.query<{ id: string }>(
    `insert into websites (installation_id, origin, plan_id, site_url, credential_hash, credential_prefix)
     values ($1, $2, (select id from plans where code = 'free'), $2, $3, $4) returning id`,
    [randomUUID(), origin, cred.hash, cred.token.slice(0, 12)],
  );
  const id = rows[0]!.id;
  siteIds.push(id);
  return { id, origin, token: cred.token };
}
type Site = Awaited<ReturnType<typeof newSite>>;
type App = ReturnType<typeof build>;

const post = (app: App, s: Site, path: string, body: object = {}) =>
  request(app).post(`/api/v1${path}`).set("Authorization", `Bearer ${s.token}`).send(body);
const createScan = (app: App, s: Site) => post(app, s, "/scans", { type: "link" });
const sendPages = (app: App, s: Site, id: string, body: object) => post(app, s, `/scans/${id}/pages`, body);
const begin = (app: App, s: Site, id: string) => post(app, s, `/scans/${id}/begin`);

async function scanRow(id: string) {
  return (await pool.query("select * from scan_jobs where id = $1", [id])).rows[0];
}
async function storedPages(id: string): Promise<{ url: string; source: string; ordinal: number }[]> {
  return (await pool.query("select url, source, ordinal from scan_pages where scan_job_id = $1 order by ordinal", [id])).rows;
}
async function insertScan(websiteId: string, status: string, createdAt = new Date()): Promise<string> {
  const { rows } = await pool.query<{ id: string }>(
    "insert into scan_jobs (website_id, type, status, created_at) values ($1, 'link', $2, $3) returning id",
    [websiteId, status, createdAt],
  );
  return rows[0]!.id;
}

describe("POST /scans", () => {
  it("creates a starting scan (201) and writes a scan.created audit row", async () => {
    const s = await newSite();
    const res = await createScan(build(), s);
    expect(res.status).toBe(201);
    expect(res.body.status).toBe("starting");
    expect(res.body.already_running).toBe(false);
    expect(res.body.type).toBe("link");
    expect(res.body.results_scan_id).toBeNull();
    expect(res.body.counts).toEqual({
      ok: 0, broken: 0, redirect: 0, restricted: 0, warning: 0, skipped: 0, indexed: 0, noindex: 0, nofollow: 0,
    });
    const row = await scanRow(res.body.scan_id);
    expect(row).toMatchObject({ website_id: s.id, type: "link", status: "starting" });
    const audits = await pool.query("select action, metadata from audit_logs where website_id = $1", [s.id]);
    expect(audits.rows).toContainEqual({ action: "scan.created", metadata: { scan_id: res.body.scan_id, type: "link" } });
  });

  it("returns the active scan (200, already_running) on a second create", async () => {
    const s = await newSite();
    const app = build();
    const first = await createScan(app, s);
    const second = await createScan(app, s);
    expect(second.status).toBe(200);
    expect(second.body.scan_id).toBe(first.body.scan_id);
    expect(second.body.already_running).toBe(true);
    expect(second.body.status).toBe("starting");
  });

  it("sweeps a scan stuck in starting for over 10 minutes, then creates a new one", async () => {
    const s = await newSite();
    const now = new Date();
    const stale = await insertScan(s.id, "starting", new Date(now.getTime() - 11 * 60_000));
    const res = await createScan(build({ now: () => now }), s);
    expect(res.status).toBe(201);
    expect(res.body.scan_id).not.toBe(stale);
    // The swept scan became failed, and failed scans are removed when a new one is created.
    expect(await scanRow(stale)).toBeUndefined();
  });

  it("sweepStaleStarting marks only scans starting for over 10 minutes as failed", async () => {
    const s = await newSite();
    const now = new Date();
    const stale = await insertScan(s.id, "starting", new Date(now.getTime() - 11 * 60_000));
    await sweepStaleStarting(pool, s.id, now);
    const row = await scanRow(stale);
    expect(row.status).toBe("failed");
    expect(row.error).toEqual(expect.any(String));
    expect(row.completed_at).not.toBeNull();

    const fresh = await insertScan(s.id, "starting", new Date(now.getTime() - 9 * 60_000));
    await sweepStaleStarting(pool, s.id, now);
    expect((await scanRow(fresh)).status).toBe("starting");
  });

  it("deletes earlier cancelled and failed scans but keeps the last completed one", async () => {
    const s = await newSite();
    const completed = await insertScan(s.id, "completed");
    const cancelled = await insertScan(s.id, "cancelled");
    const failed = await insertScan(s.id, "failed");
    await pool.query("insert into scan_pages (scan_job_id, url, source, ordinal) values ($1, $2, 'page', 0)", [
      cancelled,
      `${s.origin}/`,
    ]);
    const res = await createScan(build(), s);
    expect(res.status).toBe(201);
    expect(await scanRow(cancelled)).toBeUndefined();
    expect(await scanRow(failed)).toBeUndefined();
    expect(await storedPages(cancelled)).toEqual([]);
    expect((await scanRow(completed)).status).toBe("completed");
    expect(res.body.results_scan_id).toBe(completed);
  });

  it("rejects an invalid body with 400", async () => {
    const s = await newSite();
    const res = await post(build(), s, "/scans", { type: "seo" });
    expect(res.status).toBe(400);
    expect(ErrorBody.parse(res.body).error.code).toBe("bad_request");
  });

  it("limits POST /scans to 10 per hour per site", async () => {
    const s = await newSite();
    const app = build();
    for (let i = 0; i < 10; i++) expect((await createScan(app, s)).status).toBeLessThan(300);
    const res = await createScan(app, s);
    expect(res.status).toBe(429);
    expect(ErrorBody.parse(res.body).error.code).toBe("rate_limited");
  });
});

describe("POST /scans/:id/pages", () => {
  it("accepts same-origin http(s) URLs and rejects others", async () => {
    const s = await newSite();
    const app = build();
    const id = (await createScan(app, s)).body.scan_id as string;
    const res = await sendPages(app, s, id, {
      pages: [
        { url: `${s.origin}/`, source: "page" },
        { url: `${s.origin}/about/?utm_source=x#top`, source: "page" },
        { url: `${s.origin}/blog/hello/`, source: "post" },
        { url: "https://evil.com/x", source: "post" },
        { url: `ftp://${new URL(s.origin).host}/file`, source: "post" },
      ],
    });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ accepted: 3, rejected: 2, pages_submitted: 3 });
    expect(await storedPages(id)).toEqual([
      { url: `${s.origin}/`, source: "page", ordinal: 0 },
      { url: `${s.origin}/about/`, source: "page", ordinal: 1 },
      { url: `${s.origin}/blog/hello/`, source: "post", ordinal: 2 },
    ]);
  });

  it("accepts pages of a local site registered at an IP origin", async () => {
    // 127.0.0.1:8080 itself may already be registered locally (origin is unique), so use a random port.
    const s = await newSite(`http://127.0.0.1:${20000 + Math.floor(Math.random() * 40000)}`);
    const app = build({ config: { ALLOW_LOCAL_SITES: true } });
    const id = (await createScan(app, s)).body.scan_id as string;
    const res = await sendPages(app, s, id, { pages: [{ url: `${s.origin}/about/`, source: "page" }] });
    expect(res.body).toEqual({ accepted: 1, rejected: 0, pages_submitted: 1 });
    expect((await storedPages(id)).map((p) => p.url)).toEqual([`${s.origin}/about/`]);
  });

  it("rejects URLs with credentials", async () => {
    const s = await newSite();
    const app = build();
    const id = (await createScan(app, s)).body.scan_id as string;
    const host = new URL(s.origin).host;
    const res = await sendPages(app, s, id, { pages: [{ url: `https://user:pw@${host}/`, source: "page" }] });
    expect(res.body).toEqual({ accepted: 0, rejected: 1, pages_submitted: 0 });
    expect(await storedPages(id)).toEqual([]);
  });

  it("stores a URL sent in two batches once", async () => {
    const s = await newSite();
    const app = build();
    const id = (await createScan(app, s)).body.scan_id as string;
    await sendPages(app, s, id, { pages: [{ url: `${s.origin}/a/`, source: "page" }] });
    const res = await sendPages(app, s, id, {
      pages: [
        { url: `${s.origin}/a/`, source: "page" },
        { url: `${s.origin}/b/`, source: "page" },
      ],
    });
    expect(res.status).toBe(200);
    expect((await storedPages(id)).map((p) => p.url)).toEqual([`${s.origin}/a/`, `${s.origin}/b/`]);
  });

  it("stores at most 1,000 pages and marks the scan page_cap", async () => {
    const s = await newSite();
    const app = build();
    const id = (await createScan(app, s)).body.scan_id as string;
    const urls = Array.from({ length: 1001 }, (_, i) => ({ url: `${s.origin}/p/${i}/`, source: "page" }));
    for (const batch of [urls.slice(0, 500), urls.slice(500, 1000), urls.slice(1000)]) {
      const res = await sendPages(app, s, id, { pages: batch });
      expect(res.status).toBe(200);
    }
    const count = await pool.query("select count(*)::int as n from scan_pages where scan_job_id = $1", [id]);
    expect(count.rows[0].n).toBe(1000);
    const row = await scanRow(id);
    expect(row.truncated_reason).toBe("page_cap");
    expect(row.pages_submitted).toBe(1001);
  });

  it("stores pages_found", async () => {
    const s = await newSite();
    const app = build();
    const id = (await createScan(app, s)).body.scan_id as string;
    const res = await sendPages(app, s, id, { pages: [{ url: `${s.origin}/`, source: "page" }], pages_found: 1340 });
    expect(res.status).toBe(200);
    expect((await scanRow(id)).pages_found).toBe(1340);
  });

  it("rejects an invalid body with 400", async () => {
    const s = await newSite();
    const app = build();
    const id = (await createScan(app, s)).body.scan_id as string;
    const res = await sendPages(app, s, id, { pages: [] });
    expect(res.status).toBe(400);
  });

  it("returns 409 conflict after begin", async () => {
    const s = await newSite();
    const app = build();
    const id = (await createScan(app, s)).body.scan_id as string;
    expect((await begin(app, s, id)).status).toBe(200);
    const res = await sendPages(app, s, id, { pages: [{ url: `${s.origin}/`, source: "page" }] });
    expect(res.status).toBe(409);
    expect(ErrorBody.parse(res.body).error.code).toBe("conflict");
  });
});

describe("POST /scans/:id/begin", () => {
  it("stores the site root as the only page when none were sent", async () => {
    const s = await newSite();
    const app = build();
    const id = (await createScan(app, s)).body.scan_id as string;
    expect((await begin(app, s, id)).status).toBe(200);
    expect((await storedPages(id)).map((p) => p.url)).toEqual([`${s.origin}/`]);
  });

  it("queues the scan, enqueues one job and stores its id", async () => {
    const s = await newSite();
    const { queue, enqueued } = fakeQueue();
    const app = build({ queue });
    const id = (await createScan(app, s)).body.scan_id as string;
    await sendPages(app, s, id, { pages: [{ url: `${s.origin}/`, source: "page" }] });
    const res = await begin(app, s, id);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ scan_id: id, status: "queued" });
    expect(enqueued).toEqual([id]);
    const row = await scanRow(id);
    expect(row.status).toBe("queued");
    expect(row.pgboss_job_id).toMatch(/^[0-9a-f-]{36}$/);
    expect(row.truncated_reason).toBeNull();
  });

  it("marks page_cap when pages_found exceeds the stored pages", async () => {
    const s = await newSite();
    const app = build();
    const id = (await createScan(app, s)).body.scan_id as string;
    await sendPages(app, s, id, {
      pages: [1, 2, 3].map((i) => ({ url: `${s.origin}/p${i}/`, source: "page" })),
      pages_found: 1340,
    });
    expect((await begin(app, s, id)).status).toBe(200);
    expect((await scanRow(id)).truncated_reason).toBe("page_cap");
  });

  it("returns 409 when begun twice", async () => {
    const s = await newSite();
    const app = build();
    const id = (await createScan(app, s)).body.scan_id as string;
    await begin(app, s, id);
    const res = await begin(app, s, id);
    expect(res.status).toBe(409);
  });
});

describe("scan ownership", () => {
  it("returns 404 for another site's scan on /pages and /begin", async () => {
    const owner = await newSite();
    const other = await newSite();
    const app = build();
    const id = (await createScan(app, owner)).body.scan_id as string;
    const pages = await sendPages(app, other, id, { pages: [{ url: `${other.origin}/`, source: "page" }] });
    expect(pages.status).toBe(404);
    expect(ErrorBody.parse(pages.body).error.code).toBe("not_found");
    const b = await begin(app, other, id);
    expect(b.status).toBe(404);
    expect(ErrorBody.parse(b.body).error.code).toBe("not_found");
    expect((await scanRow(id)).status).toBe("starting");
  });

  it("returns 404 for a malformed scan id", async () => {
    const s = await newSite();
    const res = await begin(build(), s, "not-a-uuid");
    expect(res.status).toBe(404);
  });
});

const get = (app: App, s: Site, path: string) =>
  request(app).get(`/api/v1${path}`).set("Authorization", `Bearer ${s.token}`);

async function insertResults(scanId: string, n: number, over: Record<string, unknown> = {}) {
  await pool.query(
    `insert into link_results (scan_job_id, kind, url, source, status, robots_index, robots_follow)
     select $1, $2, 'https://x.example/' || g, 'page', $3, $4, $5 from generate_series(1, $6) g`,
    [scanId, over.kind ?? "link", over.status ?? "ok", over.robots_index ?? null, over.robots_follow ?? null, n],
  );
}

describe("GET /scans/:id/results", () => {
  it("pages 1,201 rows as 500/500/201 with a string cursor, last next_cursor null", async () => {
    const s = await newSite();
    const id = await insertScan(s.id, "completed");
    await insertResults(id, 1201);
    const app = build();
    const seen: string[] = [];
    let cursor: string | null = null;
    const sizes: number[] = [];
    for (let i = 0; i < 3; i++) {
      const res = await get(app, s, `/scans/${id}/results${cursor ? `?cursor=${cursor}` : ""}`);
      expect(res.status).toBe(200);
      const body = ScanResultsResponse.parse(res.body);
      sizes.push(body.items.length);
      seen.push(...body.items.map((x) => x.id));
      cursor = body.next_cursor;
    }
    expect(sizes).toEqual([500, 500, 201]);
    expect(cursor).toBeNull();
    expect(new Set(seen).size).toBe(1201);
    expect(seen.map(BigInt)).toEqual([...seen.map(BigInt)].sort((a, b) => (a < b ? -1 : 1)));
  });

  it("honours limit, and rejects limit > 500 or a bad cursor with 400", async () => {
    const s = await newSite();
    const id = await insertScan(s.id, "completed");
    await insertResults(id, 3);
    const app = build();
    const ok = await get(app, s, `/scans/${id}/results?limit=2`);
    expect(ok.body.items).toHaveLength(2);
    expect(ok.body.next_cursor).toBe(ok.body.items[1].id);
    expect((await get(app, s, `/scans/${id}/results?limit=9999`)).status).toBe(400);
    expect((await get(app, s, `/scans/${id}/results?limit=0`)).status).toBe(400);
    expect((await get(app, s, `/scans/${id}/results?cursor=abc`)).status).toBe(400);
    expect((await get(app, s, `/scans/${id}/results?cursor=1;drop`)).status).toBe(400);
  });

  it("404s for another site's scan and malformed ids", async () => {
    const a = await newSite();
    const b = await newSite();
    const id = await insertScan(a.id, "completed");
    const app = build();
    expect((await get(app, b, `/scans/${id}/results`)).status).toBe(404);
    expect((await get(app, a, "/scans/nope/results")).status).toBe(404);
  });
});

describe("GET /scans/:id", () => {
  it("returns counts matching the rows, indexed counting page rows with robots_index=index", async () => {
    const s = await newSite();
    const id = await insertScan(s.id, "completed");
    await insertResults(id, 4, { status: "ok" });
    await pool.query(
      `insert into link_results (scan_job_id, kind, url, source, status, robots_index, robots_follow) values
        ($1, 'page', 'https://p.example/1', 'page', 'ok', 'index', 'follow'),
        ($1, 'page', 'https://p.example/2', 'page', 'ok', 'index', 'nofollow'),
        ($1, 'page', 'https://p.example/3', 'page', 'ok', 'noindex', 'follow'),
        ($1, 'link', 'https://l.example/b', 'page', 'broken', null, null),
        ($1, 'link', 'https://l.example/r', 'page', 'redirect', null, null)`,
      [id],
    );
    const res = await get(build(), s, `/scans/${id}`);
    expect(res.status).toBe(200);
    expect(ScanStatus.parse(res.body).counts).toEqual({
      ok: 7, broken: 1, redirect: 1, restricted: 0, warning: 0, skipped: 0, indexed: 2, noindex: 1, nofollow: 1,
    });
  });

  it("results_scan_id: own id when completed, last completed when newer is cancelled, null when never completed", async () => {
    const s = await newSite();
    const app = build();
    const completed = await insertScan(s.id, "completed", new Date(Date.now() - 60_000));
    await pool.query("update scan_jobs set completed_at = now() - interval '1 minute' where id = $1", [completed]);
    const cancelled = await insertScan(s.id, "cancelled");
    expect((await get(app, s, `/scans/${completed}`)).body.results_scan_id).toBe(completed);
    expect((await get(app, s, `/scans/${cancelled}`)).body.results_scan_id).toBe(completed);
    const fresh = await newSite();
    const failed = await insertScan(fresh.id, "failed");
    expect((await get(app, fresh, `/scans/${failed}`)).body.results_scan_id).toBeNull();
  });

  it("404s for another site's scan and malformed ids", async () => {
    const a = await newSite();
    const b = await newSite();
    const id = await insertScan(a.id, "completed");
    expect((await get(build(), b, `/scans/${id}`)).status).toBe(404);
    expect((await get(build(), a, "/scans/not-a-uuid")).status).toBe(404);
  });
});

describe("GET /scans/latest", () => {
  it("returns the newest scan of any status", async () => {
    const s = await newSite();
    await insertScan(s.id, "completed", new Date(Date.now() - 120_000));
    const newest = await insertScan(s.id, "failed", new Date(Date.now() - 60_000));
    const res = await get(build(), s, "/scans/latest?type=link");
    expect(res.status).toBe(200);
    expect(res.body.scan_id).toBe(newest);
    expect(res.body.status).toBe("failed");
  });

  it("404s for a site with no scans, and 400s for an unknown type", async () => {
    const s = await newSite();
    expect((await get(build(), s, "/scans/latest?type=link")).status).toBe(404);
    expect((await get(build(), s, "/scans/latest?type=seo")).status).toBe(400);
  });

  it("limits reads to 600 per hour per site (601st is 429, shared across the three GETs)", async () => {
    const s = await newSite();
    const app = build();
    for (let i = 0; i < 600; i++) expect((await get(app, s, "/scans/latest")).status).toBe(404);
    const res = await get(app, s, "/scans/latest");
    expect(res.status).toBe(429);
    expect(ErrorBody.parse(res.body).error.code).toBe("rate_limited");
  }, 60_000);
});

describe("POST /scans/:id/cancel", () => {
  it.each(["starting", "queued", "running"])("cancels a %s scan and writes a scan.cancelled audit row", async (status) => {
    const s = await newSite();
    const id = await insertScan(s.id, status);
    const res = await post(build(), s, `/scans/${id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe("cancelled");
    expect((await scanRow(id)).status).toBe("cancelled");
    const audits = await pool.query("select action, metadata from audit_logs where website_id = $1", [s.id]);
    expect(audits.rows).toContainEqual({ action: "scan.cancelled", metadata: { scan_id: id } });
  });

  it.each(["completed", "failed", "cancelled"])("returns a %s scan unchanged (200, no audit)", async (status) => {
    const s = await newSite();
    const id = await insertScan(s.id, status);
    const res = await post(build(), s, `/scans/${id}/cancel`);
    expect(res.status).toBe(200);
    expect(res.body.status).toBe(status);
    const audits = await pool.query("select 1 from audit_logs where website_id = $1 and action = 'scan.cancelled'", [s.id]);
    expect(audits.rows).toHaveLength(0);
  });

  it("404s for another site's scan and malformed ids", async () => {
    const a = await newSite();
    const b = await newSite();
    const id = await insertScan(a.id, "running");
    expect((await post(build(), b, `/scans/${id}/cancel`)).status).toBe(404);
    expect((await scanRow(id)).status).toBe("running");
    expect((await post(build(), a, "/scans/nope/cancel")).status).toBe(404);
  });

  it("limits cancel to 30 per hour per site", async () => {
    const s = await newSite();
    const app = build();
    for (let i = 0; i < 30; i++) expect((await post(app, s, "/scans/nope/cancel")).status).toBe(404);
    expect((await post(app, s, "/scans/nope/cancel")).status).toBe(429);
  });
});
