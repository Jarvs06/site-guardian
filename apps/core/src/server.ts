import { safeFetch } from "@sg/shared";
import { createApp } from "./app.js";
import { loadConfig } from "./config.js";
import { ApiError } from "./lib/errors.js";
import type { AiClient } from "./lib/ai.js";
import { createPool } from "./lib/db.js";
import { createLogger } from "./lib/logger.js";
import { createSupabase } from "./lib/supabase.js";

const config = loadConfig(process.env);
const logger = createLogger(config.LOG_LEVEL);

// Placeholder until the Anthropic-backed client lands (Task 7).
const ai: AiClient = {
  reply: () => Promise.reject(ApiError.aiUnavailable()),
};

const app = createApp({
  config,
  supabase: createSupabase(config.SUPABASE_URL, config.SUPABASE_SERVICE_ROLE_KEY),
  pool: createPool(config.DATABASE_URL),
  ai,
  fetcher: safeFetch,
  logger,
});

const server = app.listen(config.PORT, () => {
  logger.info({ port: config.PORT }, "site-guardian core listening");
});

for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => {
    server.close(() => process.exit(0));
  });
}
