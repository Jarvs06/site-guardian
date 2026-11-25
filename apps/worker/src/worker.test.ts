import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { startWorker } from "./worker.js";

function capture() {
  const lines: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      lines.push(chunk.toString());
      cb();
    },
  });
  return { lines, stream };
}

describe("startWorker", () => {
  it("resolves, logs idle once, and stop() resolves", async () => {
    const { lines, stream } = capture();
    const worker = await startWorker({ logLevel: "info" }, stream);
    expect(lines.filter((l) => l.includes("worker idle — no jobs in Stage 1"))).toHaveLength(1);
    await expect(worker.stop()).resolves.toBeUndefined();
  });

  it("stop() is idempotent", async () => {
    const { stream } = capture();
    const worker = await startWorker({}, stream);
    await worker.stop();
    await expect(worker.stop()).resolves.toBeUndefined();
  });
});
