import { randomUUID } from "node:crypto";
import pg from "pg";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { ErrorBody, safeFetch } from "@sg/shared";
import { createApp } from "../app.js";
import type { Config } from "../config.js";
import { generateCredential } from "../lib/credential.js";
import { createSupabase } from "../lib/supabase.js";
import { requireSite } from "./site-auth.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const supabase = createSupabase(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const ids: string[] = [];

afterAll(async () => {
  await pool.query("delete from websites where id = any($1)", [ids]);
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

const deps = {
  config,
  supabase,
  pool,
  ai: { reply: () => Promise.reject(new Error("unused")) },
  fetcher: safeFetch,
  queue: { enqueueLinkScan: () => Promise.reject(new Error("unused")), stop: () => Promise.resolve() },
};

const app = createApp({
  ...deps,
  extraRoutes: (a) =>
    a.get("/api/v1/whoami", requireSite(deps), (req, res) => {
      res.json({ website: req.website, wpUserRef: req.wpUserRef ?? null });
    }),
});

async function seedSite(status: "active" | "suspended" | "revoked" = "active") {
  const { token, hash } = generateCredential();
  const origin = `https://auth-${randomUUID()}.example.com`;
  const r = await pool.query(
    `insert into websites (installation_id, origin, plan_id, site_url, credential_hash, credential_prefix, status)
     values ($1, $2, (select id from plans where code = 'free'), $2, $3, $4, $5) returning id`,
    [randomUUID(), origin, hash, token.slice(0, 12), status],
  );
  const id: string = r.rows[0].id;
  ids.push(id);
  return { id, origin, token };
}

const whoami = (token?: string) => {
  const r = request(app).get("/api/v1/whoami");
  return token === undefined ? r : r.set("Authorization", token);
};

describe("requireSite", () => {
  it("valid bearer -> sets req.website; wpUserRef undefined when header absent", async () => {
    const s = await seedSite();
    const res = await whoami(`Bearer ${s.token}`);
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      website: { id: s.id, origin: s.origin, planCode: "free", status: "active" },
      wpUserRef: null,
    });
  });

  it("valid x-sg-user-ref is exposed as req.wpUserRef", async () => {
    const s = await seedSite();
    const ref = "a1".repeat(32);
    const res = await whoami(`Bearer ${s.token}`).set("x-sg-user-ref", ref);
    expect(res.status).toBe(200);
    expect(res.body.wpUserRef).toBe(ref);
  });

  it("invalid x-sg-user-ref -> 400 bad_request", async () => {
    const s = await seedSite();
    const res = await whoami(`Bearer ${s.token}`).set("x-sg-user-ref", "not-hex");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("bad_request");
  });

  it.each([
    ["missing", undefined],
    ["wrong scheme", "Basic abc"],
    ["malformed token", "Bearer sgat_xyz"],
    ["uppercase hex", `Bearer sgat_${"A".repeat(64)}`],
    ["unknown token", `Bearer sgat_${"0".repeat(64)}`],
  ])("%s -> 401 unauthorized", async (_name, header) => {
    const res = await whoami(header);
    expect(res.status).toBe(401);
    expect(res.body.error.code).toBe("unauthorized");
    expect(ErrorBody.safeParse(res.body).success).toBe(true);
  });

  it.each(["suspended", "revoked"] as const)("%s site -> 403 forbidden", async (status) => {
    const s = await seedSite(status);
    const res = await whoami(`Bearer ${s.token}`);
    expect(res.status).toBe(403);
    expect(res.body.error.code).toBe("forbidden");
  });

  it("updates last_seen_at best-effort", async () => {
    const s = await seedSite();
    expect((await whoami(`Bearer ${s.token}`)).status).toBe(200);
    let seen: Date | null = null;
    for (let i = 0; i < 50 && !seen; i++) {
      seen = (await pool.query("select last_seen_at from websites where id = $1", [s.id])).rows[0].last_seen_at;
      if (!seen) await new Promise((r) => setTimeout(r, 20));
    }
    expect(seen).toBeInstanceOf(Date);
  });
});
