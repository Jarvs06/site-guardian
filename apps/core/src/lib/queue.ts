import { PgBoss } from "pg-boss";
import { LINK_SCAN_QUEUE, LINK_SCAN_QUEUE_OPTIONS, type LinkScanJob } from "@sg/shared";
import type { Logger } from "./logger.js";

export interface JobQueue {
  /** Enqueues a link scan job; resolves to the pg-boss job id. */
  enqueueLinkScan(scanId: string): Promise<string>;
  stop(): Promise<void>;
}

/** Starts pg-boss (creating its schema if needed) and makes sure the link-scan queue exists. */
export async function createPgBossQueue(databaseUrl: string, logger?: Logger): Promise<JobQueue> {
  const boss = new PgBoss(databaseUrl);
  // pg-boss emits background errors; an unhandled "error" event would crash the process.
  boss.on("error", (err) => logger?.error({ err }, "pg-boss error"));
  await boss.start();
  await boss.createQueue(LINK_SCAN_QUEUE, LINK_SCAN_QUEUE_OPTIONS);
  return {
    async enqueueLinkScan(scanId) {
      const data: LinkScanJob = { scan_id: scanId };
      const id = await boss.send(LINK_SCAN_QUEUE, data);
      if (!id) throw new Error("pg-boss did not create the link scan job");
      return id;
    },
    stop: () => boss.stop(),
  };
}
