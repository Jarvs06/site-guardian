import type pg from "pg";
import type { ResultRow, ScanSink } from "./engine.js";

/** A ScanSink that stores results and progress for one scan in Postgres. */
export function createPgSink(pool: Pick<pg.Pool, "query">, scanId: string): ScanSink {
  return {
    async alreadyChecked() {
      const { rows } = await pool.query<{ kind: ResultRow["kind"]; url: string }>(
        "select kind, url from link_results where scan_job_id = $1",
        [scanId],
      );
      const pages = new Set<string>();
      const links = new Set<string>();
      for (const r of rows) (r.kind === "page" ? pages : links).add(r.url);
      return { pages, links };
    },

    async writeResults(rows) {
      if (rows.length === 0) return;
      // A retried attempt may write a row an earlier attempt already stored; the first one stays.
      await pool.query(
        `insert into link_results
           (scan_job_id, kind, url, label, source, found_in, found_count, status, http_code, detail,
            robots_index, robots_follow)
         select $1, r.kind, r.url, r.label, r.source, r.found_in, r.found_count, r.status, r.http_code, r.detail,
                r.robots_index, r.robots_follow
           from jsonb_to_recordset($2::jsonb) as r(
             kind text, url text, label text, source text, found_in text, found_count integer, status text,
             http_code integer, detail text, robots_index text, robots_follow text)
         on conflict (scan_job_id, kind, url) do nothing`,
        [scanId, JSON.stringify(rows)],
      );
    },

    async progress(p) {
      const { rows } = await pool.query<{ status: string }>(
        `update scan_jobs
            set pages_total = $2::int, pages_checked = $3::int, links_total = $4::int, links_checked = $5::int,
                total = $2::int + $4::int, processed = $3::int + $5::int
          where id = $1
          returning status`,
        [scanId, p.pagesTotal, p.pagesChecked, p.linksTotal, p.linksChecked],
      );
      // A scan deleted under us is treated as cancelled.
      return !rows[0] || rows[0].status === "cancelled" ? "cancelled" : "continue";
    },
  };
}
