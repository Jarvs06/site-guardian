import { describe, expect, it } from "vitest";
import { LINK_SCAN_QUEUE, LINK_SCAN_QUEUE_OPTIONS } from "@sg/shared";
import { type JobBoss, startWorker } from "./worker.js";

function fakeBoss() {
  const calls: string[] = [];
  const queues: { name: string; options: unknown }[] = [];
  const workers: { name: string; options: unknown }[] = [];
  const boss: JobBoss = {
    on: () => undefined,
    start: () => {
      calls.push("start");
      return Promise.resolve();
    },
    createQueue: (name, options) => {
      queues.push({ name, options });
      return Promise.resolve();
    },
    work: (name, options) => {
      workers.push({ name, options });
      return Promise.resolve("worker-id");
    },
    stop: () => {
      calls.push("stop");
      return Promise.resolve();
    },
  };
  return { boss, calls, queues, workers };
}

const config = { databaseUrl: "postgres://unused@127.0.0.1:1/none", allowLocal: false, logLevel: "silent" };

describe("startWorker", () => {
  it("starts pg-boss, creates the link scan queue and works it one job at a time", async () => {
    const fake = fakeBoss();
    const worker = await startWorker(config, () => fake.boss);
    expect(fake.calls).toEqual(["start"]);
    expect(fake.queues).toEqual([{ name: LINK_SCAN_QUEUE, options: LINK_SCAN_QUEUE_OPTIONS }]);
    expect(fake.workers).toHaveLength(1);
    expect(fake.workers[0]).toMatchObject({ name: LINK_SCAN_QUEUE, options: { batchSize: 1 } });
    await worker.stop();
    expect(fake.calls).toEqual(["start", "stop"]);
  });

  it("stop() is idempotent", async () => {
    const fake = fakeBoss();
    const worker = await startWorker(config, () => fake.boss);
    await worker.stop();
    await expect(worker.stop()).resolves.toBeUndefined();
    expect(fake.calls.filter((c) => c === "stop")).toHaveLength(1);
  });
});
