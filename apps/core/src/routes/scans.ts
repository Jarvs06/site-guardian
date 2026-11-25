import { Router, type Request } from "express";
import type pg from "pg";
import { z } from "zod";
import {
  CreateScanRequest,
  ScanType,
  SCAN_LIMITS,
  ScanPagesRequest,
  normalizeLinkUrl,
  sameOrigin,
  type CreateScanResponse,
  type ScanPagesResponse,
  type ScanStatus,
  type ScanState,
} from "@sg/shared";
import type { AppDeps } from "../app.js";
import { audit } from "../lib/audit.js";
import { ApiError } from "../lib/errors.js";
import { limiter } from "../lib/rate-limit.js";
import {
  cancelScan,
  deleteFinishedNonCompleted,
  getStatus,
  latestScan,
  listResults,
  sweepStaleScans,
} from "../lib/scan-store.js";
import { requireSite, siteOf } from "../middleware/site-auth.js";

const HOUR = 3600;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BeginRequest = z.object({}).strict();
const LatestQuery = z.object({ type: ScanType.default("link") });
const ResultsQuery = z.object({
  cursor: z.string().regex(/^\d{1,18}$/).optional(),
  limit: z.coerce.number().int().min(1).max(SCAN_LIMITS.batchMax).default(SCAN_LIMITS.batchMax),
});
const ENQUEUE_FAILED_ERROR = "The scan couldn't be started. Please try again.";

function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body);
  if (!r.success) throw ApiError.badRequest("Invalid request body.");
  return r.data;
}

const bySite = (req: Request) => siteOf(req).id;

/** Runs fn in a transaction on one client; rolls back on any error. */
async function inTransaction<T>(pool: pg.Pool, fn: (client: pg.PoolClient) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const result = await fn(client);
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

interface LockedScan {
  status: ScanState;
  pages_found: number | null;
}

/** Locks this site's scan row; 404 for an unknown or another site's id, 409 unless still `starting`. */
async function lockStartingScan(client: pg.PoolClient, scanId: string, websiteId: string): Promise<LockedScan> {
  if (!UUID.test(scanId)) throw ApiError.notFound("Scan not found.");
  const { rows } = await client.query<LockedScan>(
    "select status, pages_found from scan_jobs where id = $1 and website_id = $2 for update",
    [scanId, websiteId],
  );
  const scan = rows[0];
  if (!scan) throw ApiError.notFound("Scan not found.");
  if (scan.status !== "starting") throw ApiError.conflict("This scan has already started.");
  return scan;
}

async function storedPageCount(client: pg.PoolClient, scanId: string): Promise<number> {
  const { rows } = await client.query<{ n: number }>("select count(*)::int as n from scan_pages where scan_job_id = $1", [
    scanId,
  ]);
  return rows[0]!.n;
}

/** The scan's status; 404 for an unknown, malformed or another site's id. */
async function ownedStatus(pool: pg.Pool, scanId: string, websiteId: string): Promise<ScanStatus> {
  if (!UUID.test(scanId)) throw ApiError.notFound("Scan not found.");
  const status = await getStatus(pool, scanId, websiteId);
  if (!status) throw ApiError.notFound("Scan not found.");
  return status;
}

export function scansRouter(deps: AppDeps): Router {
  const { pool, queue } = deps;
  const now = deps.now ?? (() => new Date());
  const r = Router();

  r.post(
    "/scans",
    requireSite(deps),
    limiter(pool, "scans-create", { points: 10, durationSec: HOUR }, bySite),
    async (req, res, next) => {
      try {
        const { type } = parse(CreateScanRequest, req.body);
        const site = siteOf(req);
        let scanId: string;
        try {
          scanId = await inTransaction(pool, async (client) => {
            await sweepStaleScans(client, site.id, now());
            await deleteFinishedNonCompleted(client, site.id, type);
            const { rows } = await client.query<{ id: string }>(
              "insert into scan_jobs (website_id, type, status) values ($1, $2, 'starting') returning id",
              [site.id, type],
            );
            return rows[0]!.id;
          });
        } catch (err) {
          if ((err as { code?: string }).code !== "23505") throw err;
          // One active scan per site and type: hand back the one already running.
          const { rows } = await pool.query<{ id: string }>(
            `select id from scan_jobs
              where website_id = $1 and type = $2 and status in ('starting', 'queued', 'running')`,
            [site.id, type],
          );
          const active = rows[0] ? await getStatus(pool, rows[0].id, site.id) : null;
          if (!active) throw err;
          const out: CreateScanResponse = { ...active, already_running: true };
          res.status(200).json(out);
          return;
        }

        await audit(
          { supabase: deps.supabase, log: req.log },
          { action: "scan.created", website_id: site.id, ip: req.ip, metadata: { scan_id: scanId, type } },
        );
        const status = await getStatus(pool, scanId, site.id);
        if (!status) throw ApiError.internal();
        const out: CreateScanResponse = { ...status, already_running: false };
        res.status(201).json(out);
      } catch (err) {
        next(err);
      }
    },
  );

  r.post(
    "/scans/:id/pages",
    requireSite(deps),
    limiter(pool, "scans-pages", { points: 30, durationSec: HOUR }, bySite),
    async (req, res, next) => {
      try {
        const body = parse(ScanPagesRequest, req.body);
        const site = siteOf(req);
        const scanId = req.params.id!;

        // Only absolute http(s) URLs on the site's own origin (no credentials) are accepted.
        const accepted: { url: string; source: string }[] = [];
        for (const page of body.pages) {
          if (!sameOrigin(page.url, site.origin)) continue;
          const n = normalizeLinkUrl(page.url, site.origin);
          if (n.ok) accepted.push({ url: n.url, source: page.source });
        }

        const out = await inTransaction(pool, async (client): Promise<ScanPagesResponse> => {
          await lockStartingScan(client, scanId, site.id);
          const stored = await storedPageCount(client, scanId);

          const unique = new Map<string, string>();
          for (const p of accepted) if (!unique.has(p.url)) unique.set(p.url, p.source);
          const existing = await client.query<{ url: string }>(
            "select url from scan_pages where scan_job_id = $1 and url = any($2)",
            [scanId, [...unique.keys()]],
          );
          for (const row of existing.rows) unique.delete(row.url);

          const fresh = [...unique.entries()];
          const room = Math.max(0, SCAN_LIMITS.maxPages - stored);
          const toStore = fresh.slice(0, room);
          if (toStore.length > 0) {
            await client.query(
              `insert into scan_pages (scan_job_id, url, source, ordinal)
               select $1, u.url, u.source, $4 + u.ord - 1
                 from unnest($2::text[], $3::text[]) with ordinality as u(url, source, ord)`,
              [scanId, toStore.map(([url]) => url), toStore.map(([, source]) => source), stored],
            );
          }

          const { rows } = await client.query<{ pages_submitted: number }>(
            `update scan_jobs
                set pages_submitted = pages_submitted + $2,
                    pages_found = coalesce($3, pages_found),
                    truncated_reason = case when $4 then 'page_cap' else truncated_reason end
              where id = $1
            returning pages_submitted`,
            [scanId, accepted.length, body.pages_found ?? null, fresh.length > room],
          );
          return {
            accepted: accepted.length,
            rejected: body.pages.length - accepted.length,
            pages_submitted: rows[0]!.pages_submitted,
          };
        });
        res.json(out);
      } catch (err) {
        next(err);
      }
    },
  );

  r.post("/scans/:id/begin", requireSite(deps), async (req, res, next) => {
    try {
      parse(BeginRequest, req.body ?? {});
      const site = siteOf(req);
      const scanId = req.params.id!;

      await inTransaction(pool, async (client) => {
        const scan = await lockStartingScan(client, scanId, site.id);
        let stored = await storedPageCount(client, scanId);
        if (stored === 0) {
          // A scan always has something to check: the site root.
          await client.query("insert into scan_pages (scan_job_id, url, source, ordinal) values ($1, $2, 'page', 0)", [
            scanId,
            `${site.origin}/`,
          ]);
          stored = 1;
        }
        const pageCap = scan.pages_found !== null && scan.pages_found > stored;
        await client.query(
          `update scan_jobs
              set status = 'queued',
                  truncated_reason = case when $2 then 'page_cap' else truncated_reason end
            where id = $1`,
          [scanId, pageCap],
        );
      });

      let jobId: string;
      try {
        jobId = await queue.enqueueLinkScan(scanId);
      } catch (err) {
        req.log?.error({ err, scan_id: scanId }, "link scan enqueue failed");
        await pool.query(
          "update scan_jobs set status = 'failed', error = $2, completed_at = now() where id = $1 and status = 'queued'",
          [scanId, ENQUEUE_FAILED_ERROR],
        );
        throw ApiError.internal(ENQUEUE_FAILED_ERROR);
      }
      await pool.query("update scan_jobs set pgboss_job_id = $2 where id = $1", [scanId, jobId]);
      res.json({ scan_id: scanId, status: "queued" });
    } catch (err) {
      next(err);
    }
  });

  const reads = limiter(pool, "scans-read", { points: 600, durationSec: HOUR }, bySite);

  // Registered before /scans/:id so "latest" isn't parsed as an id.
  r.get("/scans/latest", requireSite(deps), reads, async (req, res, next) => {
    try {
      const q = LatestQuery.safeParse(req.query);
      if (!q.success) throw ApiError.badRequest("Invalid query.");
      const status = await latestScan(pool, siteOf(req).id, q.data.type);
      if (!status) throw ApiError.notFound("Scan not found.");
      res.json(status);
    } catch (err) {
      next(err);
    }
  });

  r.get("/scans/:id", requireSite(deps), reads, async (req, res, next) => {
    try {
      const status = await ownedStatus(pool, req.params.id!, siteOf(req).id);
      res.json(status);
    } catch (err) {
      next(err);
    }
  });

  r.get("/scans/:id/results", requireSite(deps), reads, async (req, res, next) => {
    try {
      const q = ResultsQuery.safeParse(req.query);
      if (!q.success) throw ApiError.badRequest("Invalid query.");
      const scanId = req.params.id!;
      await ownedStatus(pool, scanId, siteOf(req).id);
      res.json(await listResults(pool, scanId, q.data.cursor ?? null, q.data.limit));
    } catch (err) {
      next(err);
    }
  });

  r.post(
    "/scans/:id/cancel",
    requireSite(deps),
    limiter(pool, "scans-cancel", { points: 30, durationSec: HOUR }, bySite),
    async (req, res, next) => {
      try {
        const site = siteOf(req);
        const scanId = req.params.id!;
        await ownedStatus(pool, scanId, site.id);
        if (await cancelScan(pool, scanId, site.id)) {
          await audit(
            { supabase: deps.supabase, log: req.log },
            { action: "scan.cancelled", website_id: site.id, ip: req.ip, metadata: { scan_id: scanId } },
          );
        }
        res.json(await ownedStatus(pool, scanId, site.id));
      } catch (err) {
        next(err);
      }
    },
  );

  return r;
}
