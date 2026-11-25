import pg from "pg";
import { type JobWithMetadata, PgBoss } from "pg-boss";
import { pino } from "pino";
import { LINK_SCAN_QUEUE, LINK_SCAN_QUEUE_OPTIONS, safeFetch } from "@sg/shared";
import { handleLinkScanJob } from "./link-scan/job.js";

export interface WorkerConfig {
  databaseUrl: string;
  allowLocal: boolean;
  logLevel?: string;
}

export interface WorkerHandle {
  stop(): Promise<void>;
}

const WORK_OPTIONS = { batchSize: 1, includeMetadata: true } as const;

/** The part of pg-boss the worker uses (a fake stands in for it in tests). */
export interface JobBoss {
  on(event: "error", listener: (err: Error) => void): unknown;
  start(): Promise<unknown>;
  createQueue(name: string, options: typeof LINK_SCAN_QUEUE_OPTIONS): Promise<void>;
  work(
    name: string,
    options: typeof WORK_OPTIONS,
    handler: (jobs: JobWithMetadata<unknown>[]) => Promise<void>,
  ): Promise<string>;
  stop(options?: { graceful?: boolean }): Promise<void>;
}

const defaultBoss = (databaseUrl: string): JobBoss => new PgBoss(databaseUrl);

/** Starts pg-boss and works link scan jobs one at a time until stop(). */
export async function startWorker(
  config: WorkerConfig,
  createBoss: (databaseUrl: string) => JobBoss = defaultBoss,
): Promise<WorkerHandle> {
  const log = pino({ level: config.logLevel ?? "info" });
  const pool = new pg.Pool({ connectionString: config.databaseUrl, max: 10 });
  // pg emits idle-client errors; an unhandled "error" event would crash the process.
  pool.on("error", (err) => log.error({ err }, "postgres pool error"));
  const boss = createBoss(config.databaseUrl);
  boss.on("error", (err) => log.error({ err }, "pg-boss error"));
  await boss.start();
  await boss.createQueue(LINK_SCAN_QUEUE, LINK_SCAN_QUEUE_OPTIONS);
  const deps = { pool, fetcher: safeFetch, allowLocal: config.allowLocal, now: () => Date.now(), log };
  await boss.work(LINK_SCAN_QUEUE, WORK_OPTIONS, async (jobs) => {
    for (const job of jobs) await handleLinkScanJob(deps, job);
  });
  log.info({ queue: LINK_SCAN_QUEUE }, "worker started");

  let stopping: Promise<void> | undefined;
  return {
    stop() {
      stopping ??= (async () => {
        await boss.stop({ graceful: true });
        await pool.end();
        log.info("worker stopped");
      })();
      return stopping;
    },
  };
}
