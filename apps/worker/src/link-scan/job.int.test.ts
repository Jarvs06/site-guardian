import { randomUUID } from "node:crypto";
import pg from "pg";
import { pino } from "pino";
import { afterAll, describe, expect, it } from "vitest";
import { type safeFetch, type SafeFetchOptions, type SafeFetchResponse } from "@sg/shared";
import { handleLinkScanJob } from "./job.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const log = pino({ level: "silent" });
const siteIds: string[] = [];

afterAll(async () => {
  await pool.query("delete from audit_logs where website_id = any($1)", [siteIds]);
  await pool.query("delete from websites where id = any($1)", [siteIds]); // cascades scans, pages, results
  await pool.end();
});

const HTML = { "content-type": "text/html; charset=utf-8" };
const FAILED_ERROR = "The scan stopped unexpectedly. Please try again.";

async function newSite() {
  const origin = `https://job-${randomUUID()}.example.com`;
  const { rows } = await pool.query<{ id: string }>(
    `insert into websites (installation_id, origin, plan_id, site_url, credential_hash, credential_prefix)
     values ($1, $2, (select id from plans where code = 'free'), $2, $3, 'sgat_0000000') returning id`,
    [randomUUID(), origin, randomUUID()],
  );
  const id = rows[0]!.id;
  siteIds.push(id);
  return { id, origin };
}
type Site = Awaited<ReturnType<typeof newSite>>;

async function newScan(site: Site, status = "queued", pages = [`${site.origin}/`, `${site.origin}/about/`]) {
  const { rows } = await pool.query<{ id: string }>(
    `insert into scan_jobs (website_id, type, status, pages_submitted) values ($1, 'link', $2, $3) returning id`,
    [site.id, status, pages.length],
  );
  const id = rows[0]!.id;
  for (const [i, url] of pages.entries()) {
    await pool.query("insert into scan_pages (scan_job_id, url, source, ordinal) values ($1, $2, 'page', $3)", [
      id,
      url,
      i,
    ]);
  }
  return id;
}

/** Home links to /a, /b and two external URLs; About links to /b and /c. Everything else answers 200. */
function siteFetcher(site: Site, opts: { failAfterLinkFetches?: number } = {}) {
  const pages: Record<string, string[]> = {
    [`${site.origin}/`]: ["/a", "/b", "https://ext-one.example.org/x", "https://ext-two.example.org/y"],
    [`${site.origin}/about/`]: ["/b", "/c"],
  };
  let linkFetches = 0;
  const calls: string[] = [];
  const fetcher = ((url: string): Promise<SafeFetchResponse> => {
    calls.push(url);
    const base = { status: 200, finalUrl: url, headers: {}, body: "", truncated: false };
    const hrefs = pages[url];
    if (hrefs) {
      const body = `<html><body>${hrefs.map((h) => `<a href="${h}">x</a>`).join("")}</body></html>`;
      return Promise.resolve({ ...base, headers: HTML, body });
    }
    linkFetches++;
    if (opts.failAfterLinkFetches !== undefined && linkFetches > opts.failAfterLinkFetches) {
      // Fails a little later, so the link checks that succeeded are recorded first.
      return new Promise((_, reject) => setTimeout(() => reject(new Error("worker crashed")), 50));
    }
    return Promise.resolve(base);
  }) as typeof safeFetch;
  return { fetcher, calls };
}

function deps(fetcher: typeof safeFetch, overrides: Partial<{ pool: pg.Pool; now: () => number }> = {}) {
  return { pool, fetcher, allowLocal: false, now: () => Date.now(), log, ...overrides };
}

/** A clock that moves 1 s per call, so the engine reports progress (and writes its rows) on every check. */
function steppingNow() {
  let t = Date.now();
  return () => (t += 1000);
}

/** The test pool, except that the first query matching `failOn` (or the first connect()) rejects. */
function flakyPool(fail: { query?: RegExp; connect?: boolean }): pg.Pool {
  let failed = false;
  return new Proxy(pool, {
    get(target, prop, receiver) {
      if (prop === "query") {
        return (text: unknown, ...rest: unknown[]) => {
          if (!failed && fail.query && typeof text === "string" && fail.query.test(text)) {
            failed = true;
            return Promise.reject(new Error("database went away"));
          }
          return (target.query as (...a: unknown[]) => unknown)(text, ...rest);
        };
      }
      if (prop === "connect") {
        return () => {
          if (!failed && fail.connect) {
            failed = true;
            return Promise.reject(new Error("database went away"));
          }
          return target.connect();
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}
const job = (scanId: string, retryCount = 0, retryLimit = 2) => ({
  id: randomUUID(),
  data: { scan_id: scanId },
  retryCount,
  retryLimit,
});

async function scanRow(id: string) {
  const { rows } = await pool.query<{
    status: string;
    attempt_count: number;
    started_at: Date | null;
    completed_at: Date | null;
    error: string | null;
    pages_total: number;
    pages_checked: number;
    links_total: number;
    links_checked: number;
    total: number;
    processed: number;
    truncated_reason: string | null;
  }>("select * from scan_jobs where id = $1", [id]);
  return rows[0];
}
async function resultCounts(id: string) {
  const { rows } = await pool.query<{ kind: string; n: number; distinct_urls: number }>(
    "select kind, count(*)::int as n, count(distinct url)::int as distinct_urls from link_results where scan_job_id = $1 group by kind",
    [id],
  );
  const by = (k: string) => rows.find((r) => r.kind === k) ?? { n: 0, distinct_urls: 0 };
  return { pages: by("page"), links: by("link") };
}
async function auditRows(siteId: string, action: string) {
  const { rows } = await pool.query<{ actor: string; metadata: { scan_id?: string } }>(
    "select actor, metadata from audit_logs where website_id = $1 and action = $2",
    [siteId, action],
  );
  return rows;
}

describe("handleLinkScanJob", () => {
  it("runs a queued scan to completion, writing rows, counters and the audit row", async () => {
    const site = await newSite();
    const scanId = await newScan(site);
    await handleLinkScanJob(deps(siteFetcher(site).fetcher), job(scanId));

    const scan = await scanRow(scanId);
    expect(scan).toMatchObject({ status: "completed", attempt_count: 1, pages_checked: 2, pages_total: 2, error: null });
    expect(scan?.started_at).toBeInstanceOf(Date);
    expect(scan?.completed_at).toBeInstanceOf(Date);
    expect(scan?.truncated_reason).toBeNull();
    const counts = await resultCounts(scanId);
    expect(counts.pages.n).toBe(2);
    // /a, /b, /c and the two external links (/ and /about/ aren't linked).
    expect(counts.links.n).toBe(5);
    expect(scan).toMatchObject({ links_total: 5, links_checked: 5, total: 7, processed: 7 });
    const audits = await auditRows(site.id, "scan.completed");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor: "system", metadata: { scan_id: scanId } });
  });

  it("stores links whose label has a NUL or an emoji at the cut, and whose href has a NUL", async () => {
    const site = await newSite();
    const scanId = await newScan(site, "queued", [`${site.origin}/`]);
    const emoji = "\u{1F600}";
    const body =
      `<a href="/nul">\u0000Nul</a><a href="/emoji">${"x".repeat(199)}${emoji}</a>` + `<a href="mailto:a\u0000b">M</a>`;
    const fetcher = ((url: string) =>
      Promise.resolve({ status: 200, finalUrl: url, headers: HTML, body: url.endsWith("/") ? body : "", truncated: false })) as typeof safeFetch;

    await handleLinkScanJob(deps(fetcher), job(scanId));

    expect(await scanRow(scanId)).toMatchObject({ status: "completed", links_total: 3, links_checked: 3 });
    const { rows } = await pool.query<{ url: string; label: string }>(
      "select url, label from link_results where scan_job_id = $1 and kind = 'link' order by url",
      [scanId],
    );
    expect(rows).toEqual([
      { url: `${site.origin}/emoji`, label: `${"x".repeat(199)}${emoji}` },
      { url: `${site.origin}/nul`, label: "Nul" },
      { url: "mailto:ab", label: "M" },
    ]);
  });

  it("deletes the site's older link scans when the scan completes, and keeps page_cap", async () => {
    const site = await newSite();
    const older = await newScan(site, "completed");
    await pool.query(
      "insert into link_results (scan_job_id, kind, url, source, status) values ($1, 'link', 'https://x.test/', 'page', 'ok')",
      [older],
    );
    const scanId = await newScan(site);
    await pool.query("update scan_jobs set truncated_reason = 'page_cap' where id = $1", [scanId]);
    const other = await newSite();
    const otherScan = await newScan(other, "completed");

    await handleLinkScanJob(deps(siteFetcher(site).fetcher), job(scanId));

    const { rows } = await pool.query<{ id: string }>("select id from scan_jobs where website_id = $1", [site.id]);
    expect(rows.map((r) => r.id)).toEqual([scanId]);
    expect((await scanRow(scanId))?.truncated_reason).toBe("page_cap");
    expect(await scanRow(otherScan)).toBeDefined();
  });

  it("rethrows an unexpected failure, then resumes on retry without duplicate rows", async () => {
    const site = await newSite();
    const scanId = await newScan(site);

    await expect(
      handleLinkScanJob(
        deps(siteFetcher(site, { failAfterLinkFetches: 3 }).fetcher, { now: steppingNow() }),
        job(scanId),
      ),
    ).rejects.toThrow("worker crashed");
    const afterFirst = await scanRow(scanId);
    expect(afterFirst).toMatchObject({ status: "running", attempt_count: 1 });
    expect(await auditRows(site.id, "scan.failed")).toHaveLength(0);
    // The retry has page rows and some (not all) link rows to resume from.
    const stored = await resultCounts(scanId);
    expect(stored.pages.n).toBe(2);
    expect(stored.links.n).toBeGreaterThan(0);
    expect(stored.links.n).toBeLessThan(5);
    const { rows: storedLinks } = await pool.query<{ url: string }>(
      "select url from link_results where scan_job_id = $1 and kind = 'link'",
      [scanId],
    );

    const second = siteFetcher(site);
    await handleLinkScanJob(deps(second.fetcher, { now: steppingNow() }), job(scanId, 1));

    // Links stored by the first attempt aren't fetched again.
    for (const { url } of storedLinks) expect(second.calls).not.toContain(url);

    const scan = await scanRow(scanId);
    expect(scan).toMatchObject({ status: "completed", attempt_count: 2 });
    expect(scan?.started_at?.getTime()).toBe(afterFirst?.started_at?.getTime());
    const counts = await resultCounts(scanId);
    expect(counts.pages.n).toBe(counts.pages.distinct_urls);
    expect(counts.links.n).toBe(counts.links.distinct_urls);
    expect(counts.pages.n).toBe(2);
    expect(counts.links.n).toBe(5);
    expect(scan).toMatchObject({
      pages_checked: counts.pages.n,
      links_checked: counts.links.n,
      links_total: counts.links.n,
      processed: counts.pages.n + counts.links.n,
    });
  });

  it("marks the scan failed with the friendly error after the last retry", async () => {
    const site = await newSite();
    const scanId = await newScan(site);

    await expect(
      handleLinkScanJob(deps(siteFetcher(site, { failAfterLinkFetches: 0 }).fetcher), job(scanId, 2, 2)),
    ).rejects.toThrow("worker crashed");

    const scan = await scanRow(scanId);
    expect(scan).toMatchObject({ status: "failed", error: FAILED_ERROR });
    expect(scan?.completed_at).toBeInstanceOf(Date);
    const audits = await auditRows(site.id, "scan.failed");
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({ actor: "system", metadata: { scan_id: scanId } });
  });

  it("marks the scan failed on the last retry when loading its pages fails", async () => {
    const site = await newSite();
    const scanId = await newScan(site);

    await expect(
      handleLinkScanJob(
        deps(siteFetcher(site).fetcher, { pool: flakyPool({ query: /from scan_pages/ }) }),
        job(scanId, 2, 2),
      ),
    ).rejects.toThrow("database went away");

    expect(await scanRow(scanId)).toMatchObject({ status: "failed", error: FAILED_ERROR });
    expect(await auditRows(site.id, "scan.failed")).toHaveLength(1);
  });

  it("marks the scan failed on the last retry when completing it fails", async () => {
    const site = await newSite();
    const scanId = await newScan(site);

    await expect(
      handleLinkScanJob(deps(siteFetcher(site).fetcher, { pool: flakyPool({ connect: true }) }), job(scanId, 2, 2)),
    ).rejects.toThrow("database went away");

    expect(await scanRow(scanId)).toMatchObject({ status: "failed", error: FAILED_ERROR });
    expect(await auditRows(site.id, "scan.failed")).toHaveLength(1);
    expect(await auditRows(site.id, "scan.completed")).toHaveLength(0);
  });

  it("does nothing for a scan cancelled before it started", async () => {
    const site = await newSite();
    const scanId = await newScan(site, "cancelled");
    const { fetcher, calls } = siteFetcher(site);

    await handleLinkScanJob(deps(fetcher), job(scanId));

    expect(calls).toHaveLength(0);
    expect(await scanRow(scanId)).toMatchObject({ status: "cancelled", attempt_count: 0, started_at: null });
    expect(await resultCounts(scanId)).toMatchObject({ pages: { n: 0 }, links: { n: 0 } });
  });

  it("stops and leaves the status when the scan is cancelled while running", async () => {
    const site = await newSite();
    const scanId = await newScan(site);
    const base = siteFetcher(site);
    let cancelled = false;
    const fetcher = (async (url: string, o?: SafeFetchOptions) => {
      if (!cancelled) {
        cancelled = true;
        await pool.query("update scan_jobs set status = 'cancelled' where id = $1", [scanId]);
      }
      return base.fetcher(url, o);
    }) as typeof safeFetch;

    await handleLinkScanJob(deps(fetcher), job(scanId));

    const scan = await scanRow(scanId);
    expect(scan?.status).toBe("cancelled");
    expect(scan?.truncated_reason).toBeNull();
    expect(await auditRows(site.id, "scan.completed")).toHaveLength(0);
  });
});
