# Site Guardian — Rebuild Design (overall architecture + Stage 1)

Date: 2026-11-24
Status: awaiting user approval

## 1. Intent

Site Guardian is a WordPress plugin that checks a site's health (broken
links, layout problems across screen sizes, performance, and a scan of
any public URL) and explains the results in plain English through an AI
chat. The audience is non-technical site owners.

The existing prototype lives in `../site-guardian-ai/` (WordPress plugin)
and `../site-guardian-core/` (a partial Node/TS backend). It works, but the
structure, architecture and security grew organically and were only half
migrated (see `../ARCHITECTURE.md`). This project is a **clean rebuild in a
new folder** that looks and behaves like the existing one for the user,
with the structure, architecture and security done properly from day one.
The old folders stay untouched as reference.

## 2. Goals, non-goals, anti-goals

**Goals**
- Same user-facing experience: the same pages, chat, scan screens, and
  visual design as the current plugin.
- A thin WordPress plugin that holds no third-party secrets.
- A central backend ("Core") that owns AI calls, scan jobs, credits,
  plans and audit logs for many sites.
- Security built in: no anonymous access, no SSRF, no XSS, no long-lived
  browser-exposed tokens, every action authorized and rate-limited.
- Built in stages, each ending in something that runs end to end.

**Non-goals (whole project)**
- A visual redesign. The look is ported, not reinvented.
- A separate web dashboard outside WordPress (may come later).
- Supporting site visitors as users. Visitors never use Site Guardian.

**Anti-goals (would be a failure even if it "works")**
- Any Anthropic, PageSpeed, Supabase, or billing secret in WordPress.
- Any path where an anonymous visitor can trigger a scan, an AI call, or
  spend credits.
- The AI trusting scan data supplied by the browser.
- The scanners being usable to reach private/internal networks.

## 3. Decisions made with the user

- **Approach A: one repository** containing Core API, worker, shared
  contracts, the WordPress plugin, and Supabase migrations.
- **Owner/admin only.** The Site Guardian page stays on the site front end
  with the current look, but only logged-in users with the required
  capability can see or use it. Everyone else gets the login screen
  (logged out) or a 404 (logged in without the capability).
- **Clean start.** Nothing is live: no Supabase project and no installed
  copies of the old plugin. Migration 0001 is a fresh schema, and the new
  plugin carries no upgrade path, old option names or the old page slug logic.
- **Build order:** 1 Foundation → 2 Link check → 3 AI chat with tools →
  4 Browser/layout check → 5 Performance → 6 Credits & billing.

## 4. Approaches considered

| | Approach | Trade-off | Outcome |
|---|---|---|---|
| A | Monorepo: `apps/core`, `apps/worker`, `packages/shared`, `plugin/`, `supabase/` | Two deployables (API + worker); one source of truth for contracts | **Chosen** |
| B | Same architecture, separate repos | Independent deploys, but shared types get copied and drift — a cause of the current mess | Rejected |
| C | Everything inside WordPress, hardened | Simplest hosting, but can't run Playwright, can't do multi-site credits/billing | Rejected — contradicts the product direction |

## 5. Overall architecture

```
Owner's browser (logged-in WP admin)
   │  same-origin WP REST, cookie + wp_rest nonce + capability check
   ▼
WordPress plugin (thin client, PHP)
   │  HTTPS, Bearer site credential (server-to-server only)
   ▼
Core API (Node/TS, apps/core)  ──►  Anthropic (server-side key)
   │  service-role key (server-only)
   ▼
Supabase Postgres (+ Storage)  ◄──  Worker (apps/worker): link, browser
                                     (Playwright), PageSpeed jobs
```

Rules:
1. **The browser only ever talks to its own WordPress site.** It never
   calls Core directly and never receives the site credential.
2. **WordPress only talks to Core.** One credential, stored server-side.
3. **Core is the only thing that touches Supabase, Anthropic, PageSpeed,
   and billing providers.**
4. **Scan results are produced and stored by Core/worker.** The AI reads
   results from the database by job id; it never accepts scan data from
   the client.
5. **All outbound fetches of user-supplied URLs go through one SSRF-safe
   fetcher** in Core/worker.

### Repository layout

```
site-guardian/
  apps/
    core/            Express API (TypeScript)
    worker/          job runner (TypeScript) — empty shell in Stage 1
  packages/
    shared/          zod schemas + TS types for every API request/response
                     and job payload; safe-fetch (SSRF guard)
  plugin/            WordPress plugin "site-guardian"
  supabase/
    migrations/
  docs/
  docker-compose.yml local WordPress + MySQL for end-to-end testing
```

Tooling (builder's call unless noted): pnpm workspaces, Node 22, TypeScript
strict, Vitest. **Express is kept** because the existing Core already uses
it with zod; the existing Core code is a reference to port from, not to
copy blindly.

### Job system (designed now, built in Stage 2)

Jobs live in Postgres using **pg-boss** (no Redis — one less service).
Core creates a `scan_jobs` row and enqueues; the worker claims, runs,
writes results, and updates status. The plugin polls Core (through its
own WP REST proxy) for job status. Jobs survive tab closes and restarts.

## 6. Security model

### 6.1 Owner-only front end (plugin)
- The page (`/site-health-check`, auto-created, `noindex`) checks access on
  `template_redirect`: not logged in → `auth_redirect()`; logged in without
  capability → 404.
- Capability defaults to `manage_options`, changeable via a filter
  (`site_guardian_capability`) and a Settings field.
- Every plugin REST route (`site-guardian/v1/*`) uses a
  `permission_callback` that requires the capability, and WP's cookie
  auth with the `wp_rest` nonce. **No `nopriv` AJAX handlers. No
  `admin-ajax.php` at all** — everything is REST.
- `sga_probe_token` is gone. Nothing secret is passed to the browser
  except the standard WP REST nonce.

### 6.2 Site registration and credential (plugin ↔ Core)
The current flow lets anyone who knows an `installation_id` rotate a
site's credential and lets anyone register any `site_url`. Fixed with
**domain-ownership verification**:

1. Plugin calls `POST /sites/register/start` with `installation_id` and
   `site_url`. Core returns a one-time challenge (random, 10-minute TTL).
2. Plugin stores the challenge and serves it at a public, unauthenticated,
   read-only route: `GET /wp-json/site-guardian/v1/verify/{challenge_id}`
   which returns the challenge value only if it matches a pending one.
3. Plugin calls `POST /sites/register/complete`. Core fetches the verify
   URL on `site_url` via the SSRF-safe fetcher, compares the value, then
   issues the credential (`sgat_` + 32 random bytes; Core stores SHA-256
   hash only).
4. **Rotation** requires either the current valid credential
   (`POST /sites/credential/rotate`) or a fresh ownership verification.
   `installation_id` alone grants nothing.

Local development: a Core env flag allows `http://localhost`-style site
URLs to be verified; it is refused when `NODE_ENV=production`.

The credential is stored in `wp_options` (autoload off) **encrypted** with
a key derived from WordPress's `AUTH_KEY`/`AUTH_SALT` (libsodium
`sodium_crypto_secretbox`). Optionally overridden by a `SITE_GUARDIAN_CREDENTIAL`
constant in `wp-config.php`. This is defence in depth against
database-only leaks (backups, staging clones), not against full code
execution on the WP host.

### 6.3 Core API
- All input validated with shared zod schemas; unknown fields rejected.
- Uniform error shape `{ error: { code, message }, request_id }`; no stack
  traces or internal messages in responses.
- Rate limiting backed by Postgres (works across multiple Core instances):
  per IP on public routes (register/start, register/complete), per site
  on authenticated routes. Builder chooses the library
  (`rate-limiter-flexible` with its Postgres store is the default pick).
- Config validated with zod at boot; missing required secrets fail fast
  in every environment except unit tests.
- helmet, CORS closed, JSON body limit, `x-powered-by` off, logs redact
  `authorization` and credentials, request ids on every log line.
- Suspended/revoked sites are rejected by the auth middleware.
- Every security-relevant action (register, rotate, revoke, scan create,
  credit change) writes an `audit_logs` row.

### 6.4 SSRF-safe fetcher (`packages/shared/safe-fetch`)
Built and tested in Stage 1 (domain verification uses it; all scanners
use it from Stage 2).
- Only `http`/`https`; only ports 80/443 (configurable allowlist).
- Resolve DNS, reject private, loopback, link-local, CGNAT, multicast,
  reserved, and IPv4-mapped IPv6 ranges (incl. `169.254.169.254`).
- **Connect to the resolved IP** (pinned) so DNS rebinding can't swap it.
- Follow redirects manually (max 5), re-validating each hop.
- Timeouts (connect + total), max response size, no credentials/cookies
  forwarded.

### 6.5 Database
- Supabase migrations in `supabase/migrations`, run with the Supabase CLI.
- **RLS enabled on every table with no policies** — `anon` and
  `authenticated` roles get nothing; only Core's service role reads/writes.
  Policies are added only when a user-facing dashboard needs them.
- Every query from Core scopes by the authenticated `website_id`.
- Credit changes only through the atomic `sg_apply_credit_transaction()`
  function (ported from the existing migration).

### 6.6 Front-end rendering (XSS)
The current JS builds HTML with `innerHTML` from AI replies and scraped
page data. In the rebuild:
- Untrusted text (URLs, page titles, error messages, anything from a scan)
  is inserted with `textContent` / DOM APIs, never string-built HTML.
- AI replies are rendered from markdown, then sanitized with a vendored
  **DOMPurify** before insertion.
- A Content-Security-Policy header is set on the Site Guardian page
  (no inline scripts; data passed via `wp_add_inline_script` JSON only if
  CSP allows, otherwise via a `data-` attribute — builder's call).

## 7. WordPress plugin structure

- Plugin slug/folder: `site-guardian`; text domain `site-guardian`.
- PHP ≥ 8.1, WP ≥ 6.4. Namespaced (`SiteGuardian\`), PSR-4 autoloading via
  Composer; `vendor/` is shipped in the release zip so there's no runtime
  build step.
- Modules: `Plugin` (bootstrap), `Core\Client`, `Core\Registration`,
  `Core\CredentialStore`, `Admin\SettingsPage`, `Frontend\Page`
  (create/dedupe/recreate), `Frontend\Template` (clean theme-free
  template), `Frontend\Access` (owner-only gate), `Rest\*` controllers.
- `uninstall.php` removes the plugin's options and page.
- Assets: the existing CSS is ported as-is. The existing JS is split into
  plain ES modules per screen (no bundler), keeping behaviour and markup
  identical except for the XSS fixes in §6.6.
- Coding standard: WordPress Coding Standards via PHPCS; tests with
  PHPUnit + Brain Monkey for unit tests.

## 8. Stage 1 — Foundation (this stage)

**Delivers**
1. Monorepo skeleton with pnpm workspaces, TypeScript config, lint,
   Vitest, and a `README` with local-dev steps.
2. Supabase migration 0001: the existing foundation tables (users, plans,
   websites, subscriptions, credit_balances, credit_transactions +
   `sg_apply_credit_transaction`, ai_conversations, ai_messages,
   scan_jobs shell, remote_config, audit_logs) plus
   `registration_challenges`, RLS on everything.
3. Core API routes: `GET /health`, `POST /sites/register/start`,
   `POST /sites/register/complete`, `POST /sites/credential/rotate`,
   `GET /config`, `POST /ai/chat` (plain chat, no tools and no client
   tool_data — tools arrive in Stage 3). Auth middleware, rate limiting,
   error handling, logging, audit logging.
4. `packages/shared`: zod contracts for all Stage 1 routes; safe-fetch
   with tests covering the blocked ranges, redirects, and rebinding.
5. WordPress plugin: registration with verification, encrypted credential,
   Settings page (connection status, capability setting, rotate
   credential, retry), owner-only page with the clean template, the
   chat screen ported and working against Core.
   The link scanner, layout check and remote scan screens are ported
   visually but show a "coming soon" state until their stage lands.
6. `docker-compose.yml` with WordPress + MySQL, mounting `plugin/`, for
   end-to-end testing against a local Core and local Supabase.
7. `apps/worker` as a buildable empty shell (no jobs yet).

**Done when**
- `pnpm typecheck`, `pnpm lint`, `pnpm test` pass.
- PHPCS and PHPUnit pass on the plugin.
- On a fresh local WordPress: activate plugin → registration completes
  with ownership verification → logged-in admin opens the page and chats
  with the AI through Core → logged-out visitor is sent to login →
  a subscriber-role user gets a 404.
- Registering a `site_url` the caller doesn't control fails.
- safe-fetch refuses `127.0.0.1`, `10.x`, `169.254.169.254`, `[::1]`, and
  a redirect from a public URL to a private one.

## 9. Later stages (outline — each gets its own design before building)

2. **Link check:** pg-boss job system, link worker (collects links by
   crawling the site's public pages and sitemap via safe-fetch, since
   Core can't read the WP database), progress polling, link scanner
   screen live.
3. **AI chat with tools:** Claude tool use (`start_link_check`,
   `get_scan_results`, …) executed by Core; conversation resume in UI.
4. **Browser/layout check:** Playwright worker, viewports, screenshots in
   Supabase Storage; remote scan screen live (owner-only).
5. **Performance:** PageSpeed called from the worker, daily per-plan limits.
6. **Credits & billing:** credit enforcement on job creation; Stripe
   (and/or PayPal) webhooks → plan/credit changes.

## 10. Calls made during review (proposed by Claude, not yet confirmed by the user)

1. **Sites Core can't reach.** There is one way to prove ownership: Core
   fetches a URL on the site. That URL has two forms. The first is the REST
   route. The second is a fallback query var on the home page
   (`/?site_guardian_verify={challenge_id}`), which works when a security
   plugin blocks REST for logged-out visitors. Sites behind basic auth or a
   VPN are not supported in Stage 1. They get a clear error on the Settings
   page. A DNS TXT method is out of scope, because the audience is
   non-technical.
2. **Clones and domain moves.** A website's identity is its **verified
   origin** (normalized scheme + host), not `installation_id`, which is
   stored but not `unique`. Re-verifying the same origin from the same
   installation updates the existing row. A new origin creates a new site
   row, so a staging clone on another domain becomes its own free site and
   can't take over the original. If the plugin can't decrypt its stored
   credential (for example on a clone with a different `AUTH_KEY`), it
   discards the credential and asks the admin to reconnect. Moving a paid
   site to a new domain is handled in Stage 6, once accounts and billing
   exist. Before Stage 6 nothing paid is at stake.
3. **Per-user context.** The plugin sends an opaque `wp_user_ref`: an HMAC
   of the WP user id, keyed with a per-site secret. It goes on every
   authenticated call. `ai_conversations` and `audit_logs` store it as
   `wp_user_ref text`, separate from the Core `users` FK. Each WP admin has
   their own conversations.
4. **Chat history.** Core rebuilds history from `ai_messages` by
   `conversation_id` (last 20 turns), scoped to site + `wp_user_ref`. The
   client sends only the new message and `conversation_id`. This follows the
   "AI never trusts browser data" anti-goal.
5. **Chat in Stage 1.** Plain chat. If the user asks for a check, the AI
   says that check is coming soon. The keyword-triggered scan cards in
   `chat.js` are not ported until their stage. `remote_scan` chat mode is
   dropped until Stage 4.
6. **Core URL and when registration runs.** The URL comes from a
   `SITE_GUARDIAN_CORE_URL` constant in `wp-config.php`, with a production
   default. It is not a Settings field, so a compromised admin account can't
   point the site at another server. Registration is **not** run during
   activation. After activation, an admin notice links to Settings → a
   "Connect" button. The button runs start → complete through the plugin's
   REST, shows progress, and offers a retry.

## 11. Left to the builder
- Exact libraries where not named (lint config, rate-limit store, PHP
  crypto wrapper details), file names inside modules, test layout.
- How the Settings page is laid out (follow existing plugin style).
- Hosting/deploy target for Core and worker (design keeps them stateless
  and containerisable; a `Dockerfile` per app is enough for Stage 1).
