import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.SUPABASE_URL as string;
const anon = createClient(url, process.env.SUPABASE_ANON_KEY as string, { auth: { persistSession: false } });
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });
const websiteIds: string[] = [];

async function newWebsite(): Promise<string> {
  const plan = await db.query("select id from plans where code = 'free'");
  const origin = `https://${randomUUID()}.example`;
  const r = await db.query(
    "insert into websites (installation_id, plan_id, site_url, origin, credential_hash, credential_prefix) values ($1,$2,$3,$3,$4,'sgat_abc1234') returning id",
    [randomUUID(), plan.rows[0].id, origin, randomUUID()],
  );
  websiteIds.push(r.rows[0].id);
  return r.rows[0].id;
}

async function newScan(websiteId: string, status = "starting"): Promise<string> {
  const r = await db.query("insert into scan_jobs (website_id, type, status) values ($1,'link',$2) returning id", [websiteId, status]);
  return r.rows[0].id;
}

async function pgError(sql: string, params: unknown[]): Promise<{ code?: string }> {
  try {
    await db.query(sql, params);
  } catch (e) {
    return e as { code?: string };
  }
  throw new Error("expected the statement to fail");
}

const insertResult = "insert into link_results (scan_job_id, kind, url, label, source, status) values ($1,$2,$3,$4,'page','ok')";

beforeAll(async () => { await db.connect(); });
afterAll(async () => {
  if (websiteIds.length) await db.query("delete from websites where id = any($1)", [websiteIds]);
  await db.end();
});

describe("link scan schema", () => {
  it("adds the scan_jobs columns", async () => {
    const r = await db.query("select column_name, column_default, is_nullable from information_schema.columns where table_name='scan_jobs'");
    const cols = Object.fromEntries(r.rows.map((c) => [c.column_name, c]));
    for (const c of ["pages_total", "pages_checked", "links_total", "links_checked", "pages_submitted"]) {
      expect(cols[c], c).toBeDefined();
      expect(cols[c].is_nullable).toBe("NO");
      expect(cols[c].column_default).toBe("0");
    }
    for (const c of ["pages_found", "truncated_reason", "pgboss_job_id"]) {
      expect(cols[c], c).toBeDefined();
      expect(cols[c].is_nullable).toBe("YES");
    }
  });

  it("rejects an unknown truncated_reason", async () => {
    const w = await newWebsite();
    const e = await pgError("insert into scan_jobs (website_id, type, status, truncated_reason) values ($1,'link','completed','bogus')", [w]);
    expect(e.code).toBe("23514");
  });

  it("allows only one active link scan per website, until it completes", async () => {
    const w = await newWebsite();
    const first = await newScan(w);
    const e = await pgError("insert into scan_jobs (website_id, type, status) values ($1,'link','queued')", [w]);
    expect(e.code).toBe("23505");
    await db.query("update scan_jobs set status='completed' where id=$1", [first]);
    await expect(newScan(w)).resolves.toBeTypeOf("string");
  });

  it("rejects a duplicate (scan, kind, url) but allows the same url as another kind", async () => {
    const scan = await newScan(await newWebsite());
    await db.query(insertResult, [scan, "link", "https://a.example/x", "x"]);
    expect((await pgError(insertResult, [scan, "link", "https://a.example/x", "y"])).code).toBe("23505");
    await db.query(insertResult, [scan, "page", "https://a.example/x", "x"]);
  });

  it("rejects a 201-character label and accepts 200", async () => {
    const scan = await newScan(await newWebsite());
    await db.query(insertResult, [scan, "link", "https://a.example/ok", "x".repeat(200)]);
    expect((await pgError(insertResult, [scan, "link", "https://a.example/long", "x".repeat(201)])).code).toBe("23514");
  });

  it("rejects bad kind, status, robots values and long detail", async () => {
    const scan = await newScan(await newWebsite());
    const base = "insert into link_results (scan_job_id, kind, url, source, status, detail, robots_index, robots_follow) values ($1,$2,$3,'page',$4,$5,$6,$7)";
    await db.query(base, [scan, "page", "https://a.example/1", "ok", "d".repeat(500), "noindex", "nofollow"]);
    for (const args of [
      ["bogus", "https://a.example/2", "ok", null, null, null],
      ["link", "https://a.example/3", "bogus", null, null, null],
      ["link", "https://a.example/4", "ok", "d".repeat(501), null, null],
      ["page", "https://a.example/5", "ok", null, "bogus", null],
      ["page", "https://a.example/6", "ok", null, null, "bogus"],
    ]) {
      expect((await pgError(base, [scan, ...args])).code).toBe("23514");
    }
  });

  it("stores skipped rows with a raw href as url and numbers rows with an identity id", async () => {
    const scan = await newScan(await newWebsite());
    await db.query(insertResult, [scan, "link", "mailto:a@b.c", "mail"]);
    await db.query(insertResult, [scan, "link", "javascript:void(0)", "js"]);
    const r = await db.query("select id::int as id from link_results where scan_job_id=$1 order by id", [scan]);
    expect(r.rows[1].id).toBeGreaterThan(r.rows[0].id);
  });

  it("anon cannot read link_results or scan_pages", async () => {
    for (const t of ["link_results", "scan_pages"]) {
      const { data, error } = await anon.from(t).select("*").limit(1);
      expect(error !== null || (data ?? []).length === 0, t).toBe(true);
    }
  });

  it("has RLS on the new tables and service_role privileges", async () => {
    const r = await db.query("select relname, relrowsecurity from pg_class where relname in ('link_results','scan_pages') and relkind='r'");
    expect(r.rows).toHaveLength(2);
    for (const row of r.rows) expect(row.relrowsecurity).toBe(true);
    const g = await db.query("select has_table_privilege('service_role','link_results','insert') a, has_table_privilege('anon','link_results','select') b, has_sequence_privilege('service_role', pg_get_serial_sequence('link_results','id'), 'usage') c");
    expect(g.rows[0]).toEqual({ a: true, b: false, c: true });
  });

  it("cascades scan_jobs deletes to scan_pages and link_results", async () => {
    const scan = await newScan(await newWebsite());
    await db.query("insert into scan_pages (scan_job_id, url, source, ordinal) values ($1,'https://a.example/',$2,0)", [scan, "page"]);
    expect((await pgError("insert into scan_pages (scan_job_id, url, source, ordinal) values ($1,'https://a.example/','page',1)", [scan])).code).toBe("23505");
    await db.query(insertResult, [scan, "link", "https://a.example/z", "z"]);
    await db.query("delete from scan_jobs where id=$1", [scan]);
    for (const t of ["scan_pages", "link_results"]) {
      const r = await db.query(`select count(*)::int n from ${t} where scan_job_id=$1`, [scan]);
      expect(r.rows[0].n, t).toBe(0);
    }
  });
});
