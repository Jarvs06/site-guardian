import type { Request, RequestHandler } from "express";
import type pg from "pg";
import { USER_REF_HEADER, UserRefHeader } from "@sg/shared";
import { CREDENTIAL_PATTERN, hashToken } from "../lib/credential.js";
import { ApiError } from "../lib/errors.js";

export interface SiteContext {
  id: string;
  origin: string;
  planCode: string;
  status: "active" | "suspended" | "revoked";
}

declare global {
  // Express exposes its Request type for augmentation only through this global namespace.
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      /** Set by requireSite. */
      website?: SiteContext;
      /** Opaque per-WordPress-user reference from the x-sg-user-ref header (validated). */
      wpUserRef?: string;
    }
  }
}

/** The site credential from `Authorization: Bearer sgat_…`, or null when absent/malformed. */
export function bearerToken(req: Request): string | null {
  const m = /^Bearer (\S+)$/.exec(req.headers.authorization ?? "");
  const token = m?.[1];
  return token && CREDENTIAL_PATTERN.test(token) ? token : null;
}

/** The authenticated website, for handlers mounted behind requireSite. */
export function siteOf(req: Request): SiteContext {
  if (!req.website) throw ApiError.unauthorized();
  return req.website;
}

/**
 * Authenticates a WordPress site by its bearer credential (looked up by SHA-256
 * hash). 401 for a missing/malformed/unknown credential, 403 for a suspended or
 * revoked site, 400 for an invalid x-sg-user-ref header.
 */
export function requireSite(deps: { pool: pg.Pool }): RequestHandler {
  return (req, _res, next) => {
    const token = bearerToken(req);
    if (!token) {
      next(ApiError.unauthorized("Missing or invalid site credential."));
      return;
    }
    const rawRef = req.headers[USER_REF_HEADER];
    let wpUserRef: string | undefined;
    if (rawRef !== undefined) {
      const parsed = UserRefHeader.safeParse(rawRef);
      if (!parsed.success) {
        next(ApiError.badRequest(`Invalid ${USER_REF_HEADER} header.`));
        return;
      }
      wpUserRef = parsed.data;
    }

    deps.pool
      .query<{ id: string; origin: string; status: SiteContext["status"]; plan_code: string }>(
        `select w.id, w.origin, w.status, p.code as plan_code
           from websites w join plans p on p.id = w.plan_id
          where w.credential_hash = $1`,
        [hashToken(token)],
      )
      .then(({ rows }) => {
        const row = rows[0];
        if (!row) throw ApiError.unauthorized("Missing or invalid site credential.");
        if (row.status !== "active") throw ApiError.forbidden("This site has been disabled.");
        req.website = { id: row.id, origin: row.origin, planCode: row.plan_code, status: row.status };
        req.wpUserRef = wpUserRef;
        touchLastSeen(deps.pool, row.id, req);
        next();
      })
      .catch(next);
  };
}

/** Best-effort, non-blocking; at most one write per site per minute. */
function touchLastSeen(pool: pg.Pool, id: string, req: Request): void {
  pool
    .query(
      `update websites set last_seen_at = now()
        where id = $1 and (last_seen_at is null or last_seen_at < now() - interval '1 minute')`,
      [id],
    )
    .catch((err: unknown) => req.log?.warn({ err, website_id: id }, "last_seen_at update failed"));
}
