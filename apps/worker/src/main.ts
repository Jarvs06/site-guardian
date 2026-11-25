import { z } from "zod";
import { startWorker } from "./worker.js";

const Env = z.object({
  DATABASE_URL: z.string().min(1),
  ALLOW_LOCAL_SITES: z
    .enum(["true", "false"])
    .optional()
    .transform((v) => v === "true"),
  NODE_ENV: z.string().default("development"),
  LOG_LEVEL: z.string().min(1).default("info"),
});
const env = Env.parse(process.env);
if (env.NODE_ENV === "production" && env.ALLOW_LOCAL_SITES) {
  throw new Error("Invalid configuration: ALLOW_LOCAL_SITES must not be true in production");
}

const worker = await startWorker({
  databaseUrl: env.DATABASE_URL,
  allowLocal: env.ALLOW_LOCAL_SITES,
  logLevel: env.LOG_LEVEL,
});

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    void worker.stop().then(() => process.exit(0));
  });
}
