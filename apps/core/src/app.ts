import cors from "cors";
import express from "express";
import helmet from "helmet";
import { pinoHttp } from "pino-http";
import type pg from "pg";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { safeFetch } from "@sg/shared";
import type { Config } from "./config.js";
import type { AiClient } from "./lib/ai.js";
import { createLogger, type Logger } from "./lib/logger.js";
import { errorHandler, notFoundHandler } from "./middleware/error-handler.js";
import { requestId } from "./middleware/request-id.js";
import { healthRouter } from "./routes/health.js";

export interface AppDeps {
  config: Config;
  supabase: SupabaseClient;
  pool: pg.Pool;
  ai: AiClient;
  fetcher: typeof safeFetch;
  now?: () => Date;
  logger?: Logger;
  /** Mounts additional routes before the 404/error handlers (used by feature routers and tests). */
  extraRoutes?: (app: express.Express) => void;
}

export function createApp(deps: AppDeps): express.Express {
  const { config } = deps;
  const logger = deps.logger ?? createLogger(config.LOG_LEVEL);
  const app = express();
  app.disable("x-powered-by");
  app.set("trust proxy", config.TRUST_PROXY);

  app.use(requestId);
  app.use(pinoHttp({ logger, genReqId: (req) => req.id, quietReqLogger: true }));
  app.use(helmet());
  // Closed by default: only origins explicitly listed are reflected.
  app.use(cors({ origin: config.CORS_ALLOWED_ORIGINS, methods: ["GET", "POST", "OPTIONS"] }));
  app.use(express.json({ limit: "256kb" }));

  app.use("/api/v1", healthRouter());
  deps.extraRoutes?.(app);

  app.use(notFoundHandler);
  app.use(errorHandler);
  return app;
}
