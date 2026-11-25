import type pg from "pg";
import type { Logger } from "pino";
import { LinkScanJob, type safeFetch, SCAN_LIMITS, VERSION } from "@sg/shared";
import { runLinkScan } from "./engine.js";
import { createPgSink } from "./pg-sink.js";

export interface LinkScanJobDeps {
  pool: pg.Pool;
  fetcher: typeof safeFetch;
  allowLocal: boolean;
  now: () => number;
  log: Logger;
}

export interface LinkScanJobInput {
  id: string;
  data: unknown;
  retryCount: number;
  retryLimit: number;
}

const USER_AGENT = `SiteGuardianBot/${VERSION} (+https://siteguardian.ai/bot)`;
const FAILED_ERROR = "The scan stopped unexpectedly. Please try again.";

/**
 * Runs one link scan job. Throws on an unexpected failure so pg-boss retries it; the retry resumes
 * from the rows already stored. After the last retry the scan is marked failed first.
 */
export async function handleLinkScanJob(deps: LinkScanJobDeps, job: LinkScanJobInput): Promise<void> {
  const { pool, log } = deps;
  const parsed = LinkScanJob.safeParse(job.data);
  if (!parsed.success) {
    log.error({ jobId: job.id }, "link scan job has invalid data; dropping it");
    return;
  }
  const scanId = parsed.data.scan_id;

  // Claims the scan only while it is still queued or running: one cancelled (or failed) by Core never runs.
  const claimed = await pool.query<{ website_id: string; origin: string; started_at: Date }>(
    `update scan_jobs s
        set status = 'running', started_at = coalesce(s.started_at, $2), attempt_count = s.attempt_count + 1
       from websites w
      where s.id = $1 and s.type = 'link' and s.status in ('queued', 'running') and w.id = s.website_id
      returning s.website_id, w.origin, s.started_at`,
    [scanId, new Date(deps.now())],
  );
  const scan = claimed.rows[0];
  if (!scan) {
    log.info({ scanId, jobId: job.id }, "link scan is no longer queued or running; skipping");
    return;
  }

  // Only the scan's stored page list is fetched, which keeps page fetches on the site's origin.
  const { rows: pages } = await pool.query<{ url: string; source: string }>(
    "select url, source from scan_pages where scan_job_id = $1 order by ordinal",
    [scanId],
  );

  let result;
  try {
    result = await runLinkScan({
      origin: scan.origin,
      pages,
      allowLocal: deps.allowLocal,
      userAgent: USER_AGENT,
      fetcher: deps.fetcher,
      sink: createPgSink(pool, scanId),
      now: deps.now,
      deadlineAt: scan.started_at.getTime() + SCAN_LIMITS.timeBudgetMs,
    });
  } catch (err) {
    log.error({ err, scanId, retryCount: job.retryCount }, "link scan attempt failed");
    if (job.retryCount >= job.retryLimit) await markFailed(deps, scanId, scan.website_id);
    throw err;
  }

  if (result.outcome === "cancelled") {
    log.info({ scanId }, "link scan cancelled");
    return;
  }
  await complete(deps, scanId, scan.website_id, result.truncated);
  log.info({ scanId, truncated: result.truncated }, "link scan completed");
}

/** Completes the scan, deletes the site's other link scans and audits, in one transaction. */
async function complete(
  deps: LinkScanJobDeps,
  scanId: string,
  websiteId: string,
  truncated: "link_cap" | "time_limit" | null,
): Promise<void> {
  const client = await deps.pool.connect();
  try {
    await client.query("begin");
    // An existing page_cap (set by Core) stays unless the engine reports its own reason.
    const done = await client.query<{ truncated_reason: string | null; pages_checked: number; links_checked: number }>(
      `update scan_jobs
          set status = 'completed', completed_at = $2, truncated_reason = coalesce($3, truncated_reason)
        where id = $1 and status = 'running'
        returning truncated_reason, pages_checked, links_checked`,
      [scanId, new Date(deps.now()), truncated],
    );
    const row = done.rows[0];
    if (!row) {
      // Cancelled after the engine's last progress check: leave it as it is.
      await client.query("rollback");
      return;
    }
    await client.query("delete from scan_jobs where website_id = $1 and type = 'link' and id <> $2", [
      websiteId,
      scanId,
    ]);
    await client.query(
      `insert into audit_logs (website_id, actor, action, metadata) values ($1, 'system', 'scan.completed', $2)`,
      [
        websiteId,
        {
          scan_id: scanId,
          truncated_reason: row.truncated_reason,
          pages_checked: row.pages_checked,
          links_checked: row.links_checked,
        },
      ],
    );
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/** Marks the scan failed after its last attempt, with the scan.failed audit row. */
async function markFailed(deps: LinkScanJobDeps, scanId: string, websiteId: string): Promise<void> {
  const client = await deps.pool.connect();
  try {
    await client.query("begin");
    const { rowCount } = await client.query(
      `update scan_jobs set status = 'failed', error = $2, completed_at = $3
        where id = $1 and status in ('queued', 'running')`,
      [scanId, FAILED_ERROR, new Date(deps.now())],
    );
    if (rowCount) {
      await client.query(
        `insert into audit_logs (website_id, actor, action, metadata) values ($1, 'system', 'scan.failed', $2)`,
        [websiteId, { scan_id: scanId }],
      );
    }
    await client.query("commit");
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    deps.log.error({ err, scanId }, "could not mark the link scan failed");
  } finally {
    client.release();
  }
}
