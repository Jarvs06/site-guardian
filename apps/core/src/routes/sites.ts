import { Router, type Request } from "express";
import type { z } from "zod";
import {
  InvalidOriginError,
  RegisterCompleteRequest,
  RegisterStartRequest,
  SafeFetchError,
  normalizeOrigin,
  type RegisterCompleteResponse,
  type RegisterStartResponse,
  type RotateResponse,
} from "@sg/shared";
import type { AppDeps } from "../app.js";
import { audit } from "../lib/audit.js";
import { DISPLAY_PREFIX_LENGTH, generateChallenge, generateCredential, hashMatches, hashToken } from "../lib/credential.js";
import { ApiError } from "../lib/errors.js";
import { limiter } from "../lib/rate-limit.js";
import { bearerToken, requireSite, siteOf } from "../middleware/site-auth.js";

const CHALLENGE_TTL_MS = 10 * 60_000;
const HOUR = 3600;
const LOCAL_SUFFIXES = [".localhost", ".local", ".internal", ".lan"];

type VerifyFailure = "challenge_invalid" | "unreachable" | "mismatch" | "redirected_off_origin";

interface ChallengeRow {
  id: string;
  installation_id: string;
  origin: string;
  site_url: string;
  site_name: string | null;
  wp_version: string | null;
  plugin_version: string | null;
  php_version: string | null;
  challenge_hash: string;
}

function parse<T extends z.ZodType>(schema: T, body: unknown): z.infer<T> {
  const r = schema.safeParse(body);
  if (!r.success) throw ApiError.badRequest("Invalid request body.");
  return r.data;
}

function clientIp(req: Request): string {
  return req.ip ?? "unknown";
}

/** Normalized origin for a site_url, rejecting local/IP hosts (unless allowed) and empty DNS labels. */
function siteOrigin(siteUrl: string, allowLocal: boolean): string {
  let origin: string;
  try {
    origin = normalizeOrigin(siteUrl, { allowIpHosts: allowLocal });
  } catch (err) {
    if (err instanceof InvalidOriginError) throw ApiError.badRequest("site_url is not a valid public site address.");
    throw err;
  }
  // Identity and verification are origin-only, so the site must live at the origin root.
  // Verifying a sub-folder install at its path would let one path's owner re-verify the origin.
  if (new URL(siteUrl).pathname.replace(/\/+$/, "") !== "") {
    throw ApiError.badRequest(
      "WordPress installed in a sub-folder (like example.com/blog) can't be connected yet. Site Guardian currently supports sites at the root of their domain.",
    );
  }
  const host = new URL(origin).hostname.toLowerCase();
  if (!host.startsWith("[") && host.split(".").some((label) => label === "")) {
    throw ApiError.badRequest("site_url is not a valid public site address.");
  }
  if (!allowLocal && (host === "localhost" || LOCAL_SUFFIXES.some((s) => host.endsWith(s)))) {
    throw ApiError.badRequest("site_url must be a public address. Local sites can't be connected.");
  }
  return origin;
}

const DEFAULT_PORTS: Record<string, string> = { "http:": "80", "https:": "443" };

/**
 * True when a (possibly redirected) final URL is still on the origin: exact same
 * hostname; http→https on that host is allowed; the final port must be the
 * origin's port or the default port for the final scheme.
 */
function sameSite(finalUrl: string, origin: string): boolean {
  let f: URL;
  try {
    f = new URL(finalUrl);
  } catch {
    return false;
  }
  const o = new URL(origin);
  if (f.hostname !== o.hostname) return false;
  if (f.protocol !== "http:" && f.protocol !== "https:") return false;
  const finalPort = f.port || DEFAULT_PORTS[f.protocol];
  const originPort = o.port || DEFAULT_PORTS[o.protocol];
  return finalPort === originPort || finalPort === DEFAULT_PORTS[f.protocol];
}

function verificationFailed(reason: VerifyFailure): ApiError {
  switch (reason) {
    case "challenge_invalid":
      return ApiError.verificationFailed("This verification request is invalid or has expired. Please start again.");
    case "unreachable":
      return ApiError.verificationFailed(
        "Your site couldn't be reached to verify ownership. Make sure it is publicly accessible, then start again.",
      );
    case "redirected_off_origin":
      return ApiError.verificationFailed(
        "Your site redirected the verification request to a different address. Use your site's exact address, then start again.",
      );
    case "mismatch":
      return ApiError.verificationFailed(
        "Your site didn't return the expected verification code. Make sure the plugin is active, then start again.",
      );
  }
}

export function sitesRouter(deps: AppDeps): Router {
  const { config, pool } = deps;
  const now = deps.now ?? (() => new Date());
  const allowLocal = config.ALLOW_LOCAL_SITES;
  const r = Router();

  r.post(
    "/sites/register/start",
    limiter(pool, "sites-register-start", { points: 20, durationSec: HOUR }, clientIp),
    async (req, res, next) => {
      try {
        const body = parse(RegisterStartRequest, req.body);
        const origin = siteOrigin(body.site_url, allowLocal);
        const challenge = generateChallenge();
        const expiresAt = new Date(now().getTime() + CHALLENGE_TTL_MS);
        const { rows } = await pool.query<{ id: string }>(
          `insert into registration_challenges
             (installation_id, origin, site_url, site_name, wp_version, plugin_version, php_version, challenge_hash, expires_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9) returning id`,
          [
            body.installation_id,
            origin,
            body.site_url,
            body.site_name ?? null,
            body.wp_version ?? null,
            body.plugin_version ?? null,
            body.php_version ?? null,
            challenge.hash,
            expiresAt,
          ],
        );
        const out: RegisterStartResponse = {
          challenge_id: rows[0]!.id,
          challenge: challenge.value,
          expires_at: expiresAt.toISOString(),
        };
        res.status(201).json(out);
      } catch (err) {
        next(err);
      }
    },
  );

  /** Fetches the verify URLs in order; null on success, otherwise a reason code. */
  async function verify(ch: ChallengeRow): Promise<VerifyFailure | null> {
    const port = Number(new URL(ch.origin).port);
    const allowedPorts = allowLocal && port ? [80, 443, port] : [80, 443];
    const urls = [
      `${ch.origin}/wp-json/site-guardian/v1/verify/${ch.id}`,
      `${ch.origin}/?site_guardian_verify=${ch.id}`,
    ];
    let reached = false;
    let offOrigin = false;
    for (const url of urls) {
      try {
        const resp = await deps.fetcher(url, { timeoutMs: 10_000, maxBytes: 4096, allowPrivate: allowLocal, allowedPorts });
        reached = true;
        // Proof must come from the origin itself, not wherever it redirects to.
        if (!sameSite(resp.finalUrl, ch.origin)) {
          offOrigin = true;
          continue;
        }
        if (resp.status !== 200 || resp.truncated) continue;
        let value: unknown;
        try {
          value = (JSON.parse(resp.body) as { challenge?: unknown } | null)?.challenge;
        } catch {
          continue;
        }
        if (typeof value === "string" && hashMatches(value, ch.challenge_hash)) return null;
      } catch (err) {
        if (!(err instanceof SafeFetchError)) throw err;
      }
    }
    if (offOrigin) return "redirected_off_origin";
    return reached ? "mismatch" : "unreachable";
  }

  r.post(
    "/sites/register/complete",
    limiter(pool, "sites-register-complete", { points: 20, durationSec: HOUR }, clientIp),
    async (req, res, next) => {
      try {
        const { challenge_id } = parse(RegisterCompleteRequest, req.body);
        const auditDeps = { supabase: deps.supabase, log: req.log };

        // Consume first, atomically: a replay (even one racing a slow fetch) finds nothing.
        const { rows } = await pool.query<ChallengeRow>(
          `update registration_challenges set used_at = now()
            where id = $1 and used_at is null and expires_at > now()
          returning id, installation_id, origin, site_url, site_name, wp_version, plugin_version, php_version, challenge_hash`,
          [challenge_id],
        );
        const ch = rows[0];
        if (!ch) {
          await audit(auditDeps, {
            action: "site.verification_failed",
            ip: req.ip,
            metadata: { reason: "challenge_invalid" },
          });
          throw verificationFailed("challenge_invalid");
        }

        const failure = await verify(ch);
        if (failure) {
          await audit(auditDeps, {
            action: "site.verification_failed",
            ip: req.ip,
            metadata: { reason: failure, origin: ch.origin },
          });
          throw verificationFailed(failure);
        }

        const cred = generateCredential();
        const result = await upsertWebsite(deps, ch, cred.hash, cred.token.slice(0, DISPLAY_PREFIX_LENGTH));
        if (result.kind === "disabled") {
          await audit(auditDeps, {
            action: "site.verification_failed",
            website_id: result.websiteId,
            ip: req.ip,
            metadata: { reason: "site_disabled", origin: ch.origin },
          });
          throw ApiError.forbidden("This site has been disabled and can't be reconnected.");
        }
        if (result.kind === "created") {
          await audit(auditDeps, {
            action: "site.registered",
            website_id: result.websiteId,
            ip: req.ip,
            metadata: { origin: ch.origin, installation_id: ch.installation_id },
          });
        } else {
          await audit(auditDeps, {
            action: "site.credential_rotated",
            website_id: result.websiteId,
            ip: req.ip,
            metadata: { via: "register", installation_changed: result.installationChanged },
          });
        }
        const out: RegisterCompleteResponse = {
          website_id: result.websiteId,
          credential: cred.token,
          plan_code: result.planCode,
        };
        res.status(result.kind === "created" ? 201 : 200).json(out);
      } catch (err) {
        next(err);
      }
    },
  );

  r.post(
    "/sites/credential/rotate",
    requireSite(deps),
    limiter(pool, "sites-rotate", { points: 10, durationSec: HOUR }, (req) => siteOf(req).id),
    async (req, res, next) => {
      try {
        const site = siteOf(req);
        const current = bearerToken(req);
        const cred = generateCredential();
        // Conditioned on the presented credential so two concurrent rotations can't both win.
        const { rowCount } = await pool.query(
          `update websites
              set credential_hash = $2, credential_prefix = $3, credential_rotated_at = now()
            where id = $1 and status = 'active' and credential_hash = $4`,
          [site.id, cred.hash, cred.token.slice(0, DISPLAY_PREFIX_LENGTH), hashToken(current ?? "")],
        );
        if (rowCount !== 1) throw ApiError.unauthorized("Missing or invalid site credential.");
        await audit(
          { supabase: deps.supabase, log: req.log },
          { action: "site.credential_rotated", website_id: site.id, ip: req.ip, metadata: { via: "rotate" } },
        );
        const out: RotateResponse = { credential: cred.token };
        res.json(out);
      } catch (err) {
        next(err);
      }
    },
  );

  return r;
}

type UpsertResult =
  | { kind: "created" | "rotated"; websiteId: string; planCode: string; installationChanged: boolean }
  | { kind: "disabled"; websiteId: string };

/**
 * Website identity is the verified origin. One transaction, serialized per origin
 * by an advisory lock: an existing active site gets the new credential, a
 * suspended/revoked one is left untouched, a new origin gets a free-plan website
 * plus its credit_balances row (both or neither).
 */
async function upsertWebsite(
  deps: AppDeps,
  ch: ChallengeRow,
  credentialHash: string,
  credentialPrefix: string,
): Promise<UpsertResult> {
  const client = await deps.pool.connect();
  try {
    await client.query("begin");
    await client.query("select pg_advisory_xact_lock(hashtext('websites.origin:' || $1))", [ch.origin]);
    const existing = await client.query<{ id: string; status: string; installation_id: string; plan_code: string }>(
      `select w.id, w.status, w.installation_id, p.code as plan_code
         from websites w join plans p on p.id = w.plan_id
        where w.origin = $1 for update of w`,
      [ch.origin],
    );
    const row = existing.rows[0];
    let result: UpsertResult;
    if (row && row.status !== "active") {
      result = { kind: "disabled", websiteId: row.id };
    } else if (row) {
      await client.query(
        `update websites
            set credential_hash = $2, credential_prefix = $3, credential_rotated_at = now(),
                installation_id = $4, site_url = $5, site_name = $6,
                wp_version = $7, plugin_version = $8, php_version = $9
          where id = $1`,
        [
          row.id,
          credentialHash,
          credentialPrefix,
          ch.installation_id,
          ch.site_url,
          ch.site_name,
          ch.wp_version,
          ch.plugin_version,
          ch.php_version,
        ],
      );
      result = {
        kind: "rotated",
        websiteId: row.id,
        planCode: row.plan_code,
        installationChanged: row.installation_id !== ch.installation_id,
      };
    } else {
      const inserted = await client.query<{ id: string }>(
        `insert into websites
           (installation_id, origin, plan_id, site_url, site_name, credential_hash, credential_prefix,
            wp_version, plugin_version, php_version)
         values ($1, $2, (select id from plans where code = 'free'), $3, $4, $5, $6, $7, $8, $9)
         returning id`,
        [
          ch.installation_id,
          ch.origin,
          ch.site_url,
          ch.site_name,
          credentialHash,
          credentialPrefix,
          ch.wp_version,
          ch.plugin_version,
          ch.php_version,
        ],
      );
      const websiteId = inserted.rows[0]!.id;
      await client.query("insert into credit_balances (website_id) values ($1)", [websiteId]);
      result = { kind: "created", websiteId, planCode: "free", installationChanged: false };
    }
    await client.query("commit");
    return result;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}
