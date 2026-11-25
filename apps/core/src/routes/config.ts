import { Router } from "express";
import type { ConfigResponse } from "@sg/shared";
import type { AppDeps } from "../app.js";
import { requireSite, siteOf } from "../middleware/site-auth.js";

/** GET /config: remote_config rows as a key → value object, plus the calling site's id and status. */
export function configRouter(deps: AppDeps): Router {
  const r = Router();
  r.get("/config", requireSite(deps), async (req, res, next) => {
    try {
      const site = siteOf(req);
      const { rows } = await deps.pool.query<{ key: string; value: unknown }>("select key, value from remote_config");
      const out: ConfigResponse = {
        config: Object.fromEntries(rows.map((row) => [row.key, row.value])),
        website: { id: site.id, status: site.status },
      };
      res.json(out);
    } catch (err) {
      next(err);
    }
  });
  return r;
}
