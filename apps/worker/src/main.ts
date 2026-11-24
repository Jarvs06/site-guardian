import { z } from "zod";
import { startWorker } from "./worker.js";

const Env = z.object({ LOG_LEVEL: z.string().min(1).default("info") });
const env = Env.parse(process.env);

const worker = await startWorker({ logLevel: env.LOG_LEVEL });

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    void worker.stop().then(() => process.exit(0));
  });
}
