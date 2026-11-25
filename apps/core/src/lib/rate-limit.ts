import type { Request, RequestHandler } from "express";
import type pg from "pg";
import { RateLimiterPostgres, RateLimiterRes } from "rate-limiter-flexible";
import { ApiError } from "./errors.js";

/**
 * Postgres-backed fixed-window limiter. Exceeding the limit yields 429 with Retry-After.
 * If the store itself fails the request fails with 500 (fail closed, never silently allowed).
 */
export function limiter(
  pool: pg.Pool,
  name: string,
  opts: { points: number; durationSec: number },
  key: (req: Request) => string,
): RequestHandler {
  const rl = new RateLimiterPostgres({
    storeClient: pool,
    tableName: "rate_limits",
    tableCreated: true,
    keyPrefix: name,
    points: opts.points,
    duration: opts.durationSec,
  });
  return (req, res, next) => {
    rl.consume(key(req))
      .then(() => next())
      .catch((err: unknown) => {
        if (err instanceof RateLimiterRes) {
          const e = ApiError.rateLimited(err.msBeforeNext / 1000);
          res.setHeader("Retry-After", e.headers["Retry-After"] ?? "60");
          next(e);
          return;
        }
        req.log?.error({ err, limiter: name }, "rate limiter store error");
        next(ApiError.internal());
      });
  };
}
