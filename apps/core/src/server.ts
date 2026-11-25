import { safeFetch } from "@sg/shared";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { createAnthropicAi, type AiClient } from "./lib/ai.js";
import { createPool } from "./lib/db.js";
import { createLogger } from "./lib/logger.js";
import { createPgBossQueue } from "./lib/queue.js";
import { createSupabase } from "./lib/supabase.js";

const config = loadConfig(process.env);
const logger = createLogger(config.LOG_LEVEL);

const ai: AiClient = config.AI_STUB
  ? { reply: () => Promise.resolve("Hi! (stub reply)") }
  : createAnthropicAi(config, undefined, logger);

// pg-boss must be running (schema and queue created) before Core accepts scans.
const queue = await createPgBossQueue(config.DATABASE_URL, logger);

const app = createApp({
  config,
  supabase: createSupabase(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY),
  pool: createPool(config.DATABASE_URL),
  ai,
  fetcher: safeFetch,
  queue,
  logger,
});

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, "site-guardian core listening");
});

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    server.close(() => {
      queue
        .stop()
        .catch((err: unknown) => logger.error({ err }, "pg-boss stop failed"))
        .finally(() => process.exit(0));
    });
  });
}
