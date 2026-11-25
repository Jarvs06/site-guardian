import type pg from "pg";
import { SCAN_LIMITS, type LinkResult, type ScanStatus, type ScanType } from "@sg/shared";

/** A pool or a checked-out client (inside a transaction). */
type Db = Pick<pg.Pool, "query">;

const STALE_STARTING_ERROR = "The scan didn't start in time. Please try again.";
const STALE_ACTIVE_ERROR = "The scan stopped unexpectedly. Please try again.";
/** A queued or running scan older than this can't still be working (time budget 20 min, 3 attempts). */
const STALE_ACTIVE_MS = 2 * 60 * 60_000;

interface ScanRow {
  id: string;
  type: ScanStatus["type"];
  status: ScanStatus["status"];
  pages_total: number;
  pages_checked: number;
  links_total: number;
  links_checked: number;
  pages_submitted: number;
  pages_found: number | null;
  truncated_reason: ScanStatus["truncated_reason"];
  created_at: Date;
  started_at: Date | null;
  completed_at: Date | null;
  error: string | null;
  last_completed_id: string | null;
}

interface CountsRow {
  ok: number;
  broken: number;
  redirect: number;
  restricted: number;
  warning: number;
  skipped: number;
  indexed: number;
  noindex: number;
  nofollow: number;
}

/** The scan's status for its own site, or null when it doesn't exist or belongs to another site. */
export async function getStatus(db: Db, scanId: string, websiteId: string): Promise<ScanStatus | null> {
  const { rows } = await db.query<ScanRow>(
    `select s.id, s.type, s.status, s.pages_total, s.pages_checked, s.links_total, s.links_checked,
            s.pages_submitted, s.pages_found, s.truncated_reason, s.created_at, s.started_at,
            s.completed_at, s.error,
            (select c.id from scan_jobs c
              where c.website_id = s.website_id and c.type = s.type and c.status = 'completed'
              order by c.completed_at desc nulls last, c.created_at desc limit 1) as last_completed_id
       from scan_jobs s
      where s.id = $1 and s.website_id = $2`,
    [scanId, websiteId],
  );
  const row = rows[0];
  if (!row) return null;

  const grouped = await db.query<{ status: string; robots_index: string | null; robots_follow: string | null; n: number }>(
    `select status, robots_index, robots_follow, count(*)::int as n
       from link_results where scan_job_id = $1
      group by status, robots_index, robots_follow`,
    [scanId],
  );
  const counts: CountsRow = { ok: 0, broken: 0, redirect: 0, restricted: 0, warning: 0, skipped: 0, indexed: 0, noindex: 0, nofollow: 0 };
  for (const g of grouped.rows) {
    if (g.status in counts) counts[g.status as keyof CountsRow] += g.n;
    if (g.robots_index === "index") counts.indexed += g.n;
    if (g.robots_index === "noindex") counts.noindex += g.n;
    if (g.robots_follow === "nofollow") counts.nofollow += g.n;
  }

  return {
    scan_id: row.id,
    type: row.type,
    status: row.status,
    pages_total: row.pages_total,
    pages_checked: row.pages_checked,
    links_total: row.links_total,
    links_checked: row.links_checked,
    pages_submitted: row.pages_submitted,
    pages_found: row.pages_found,
    truncated_reason: row.truncated_reason,
    results_scan_id: row.status === "completed" ? row.id : row.last_completed_id,
    counts,
    created_at: row.created_at.toISOString(),
    started_at: row.started_at?.toISOString() ?? null,
    completed_at: row.completed_at?.toISOString() ?? null,
    error: row.error,
  };
}

/** The site's newest scan of this type, whatever its status. */
export async function latestScan(db: Db, websiteId: string, type: ScanType): Promise<ScanStatus | null> {
  const { rows } = await db.query<{ id: string }>(
    "select id from scan_jobs where website_id = $1 and type = $2 order by created_at desc limit 1",
    [websiteId, type],
  );
  return rows[0] ? getStatus(db, rows[0].id, websiteId) : null;
}

/**
 * Fails the site's stale scans: `starting` past the starting timeout, and `queued` or `running` past the
 * stale-active timeout (a worker's last attempt was killed, so nothing will finish it).
 */
export async function sweepStaleScans(db: Db, websiteId: string, now: Date): Promise<void> {
  const startingCutoff = new Date(now.getTime() - SCAN_LIMITS.startingTimeoutMs);
  const activeCutoff = new Date(now.getTime() - STALE_ACTIVE_MS);
  await db.query(
    `update scan_jobs
        set status = 'failed', completed_at = $4,
            error = case when status = 'starting' then $5 else $6 end
      where website_id = $1
        and ((status = 'starting' and created_at < $2) or (status in ('queued', 'running') and created_at < $3))`,
    [websiteId, startingCutoff, activeCutoff, now, STALE_STARTING_ERROR, STALE_ACTIVE_ERROR],
  );
}

/** Deletes the site's cancelled and failed scans of this type (their pages and results cascade). */
export async function deleteFinishedNonCompleted(db: Db, websiteId: string, type: ScanType): Promise<void> {
  await db.query("delete from scan_jobs where website_id = $1 and type = $2 and status in ('cancelled', 'failed')", [
    websiteId,
    type,
  ]);
}

/** One page of a scan's results (ordered by id), `limit` items after `cursor`; next_cursor is null on the last page. */
export async function listResults(
  db: Db,
  scanId: string,
  cursor: string | null,
  limit: number,
): Promise<{ items: LinkResult[]; next_cursor: string | null }> {
  const { rows } = await db.query<LinkResult>(
    `select id::text as id, kind, url, label, source, found_in, found_count, status, http_code, detail,
            robots_index, robots_follow
       from link_results
      where scan_job_id = $1 and ($2::bigint is null or id > $2::bigint)
      order by id asc
      limit $3`,
    [scanId, cursor, limit + 1],
  );
  const items = rows.slice(0, limit);
  return { items, next_cursor: rows.length > limit ? items[items.length - 1]!.id : null };
}

/** Cancels the site's scan if it is still active. Returns whether it moved to `cancelled`. */
export async function cancelScan(db: Db, scanId: string, websiteId: string): Promise<boolean> {
  const { rowCount } = await db.query(
    `update scan_jobs set status = 'cancelled', completed_at = now()
      where id = $1 and website_id = $2 and status in ('starting', 'queued', 'running')`,
    [scanId, websiteId],
  );
  return (rowCount ?? 0) > 0;
}
