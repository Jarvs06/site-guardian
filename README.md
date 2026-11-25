# Site Guardian

pnpm monorepo:

| Path | What |
|---|---|
| `apps/core` | Core API (Express). The only component that holds secrets and talks to Anthropic and Supabase. |
| `apps/worker` | Background worker: runs link scans from the pg-boss `link-scan` queue. |
| `packages/shared` | API contracts, origin normalization, SSRF-safe fetcher. |
| `plugin/` | The WordPress plugin (PHP + plain ES-module front end, no bundler). |
| `supabase/` | Database migrations and their integration tests. |
| `e2e/` | Playwright end-to-end checks against a local WordPress. |

Design and plans: `docs/superpowers/specs/`, `docs/superpowers/plans/`.

## Prerequisites

- Node 22+ (`nvm use`, see `.nvmrc`) and pnpm (`corepack enable` or `brew install pnpm`)
- PHP 8.1+ and Composer (plugin tests)
- Docker (Docker Desktop, or `colima start` on macOS)
- Supabase CLI

## 1. Install

```sh
pnpm install
(cd plugin && composer install)
pnpm --filter e2e exec playwright install chromium   # once, for the e2e checks
```

## 2. Database (local Supabase)

```sh
supabase start        # starts Postgres etc. in Docker and applies supabase/migrations
supabase db reset     # later: wipe and re-apply migrations + seed
```

`supabase status -o env` prints the local URLs and keys used below.

## 3. Run Core

Core reads its configuration from the environment; `apps/core/.env.example` documents every variable.

```sh
cp apps/core/.env.example apps/core/.env
```

Fill in from `supabase status -o env`: `SUPABASE_URL` (= `API_URL`), `SUPABASE_SERVICE_ROLE_KEY`
(= `SERVICE_ROLE_KEY`), `DATABASE_URL` (= `DB_URL`). For local development also set:

```sh
ALLOW_LOCAL_SITES=true   # lets the local WordPress (http://127.0.0.1:8080) register
AI_STUB=true             # canned AI replies; or leave false and set ANTHROPIC_API_KEY
```

Both flags are refused when `NODE_ENV=production`.

```sh
pnpm build
node --env-file=apps/core/.env apps/core/dist/server.js     # http://localhost:8787/api/v1/health
```

## 3b. Run the worker

Link scans run in the worker. It reads `DATABASE_URL`, `ALLOW_LOCAL_SITES`, `LOG_LEVEL` and
`NODE_ENV` from the same file as Core, and works the jobs Core queues (pg-boss, in the same database):

```sh
node --env-file=apps/core/.env apps/worker/dist/main.js
```

Without it, a scan started from the Link Scanner stays at "Starting scan…" until a worker runs.

## 4. Local WordPress

```sh
docker compose up -d       # WordPress (http://127.0.0.1:8080) + MySQL
scripts/dev-setup.sh       # installs WordPress, creates users and fixtures, activates the plugin (idempotent)
```

Users: `admin` / `admin-pass-local` (administrator), `sub` / `sub-pass-local` (subscriber).
The plugin directory is mounted into the container read-only, so PHP and JS edits show up
on reload. WordPress reaches Core on the host at `host.docker.internal:8787`.

Link scan fixtures (created or updated by slug on every `dev-setup.sh` run):

- post `sg-fixture-links`: links to `/sg-missing-page/` (Broken), `https://example.com/` (OK),
  `mailto:hi@example.com` (Skipped) and `/?replytocom=1` (WordPress clutter, no row)
- page `sg-fixture-noindex`: noindex, set by the mu-plugin `scripts/mu-plugins/sg-fixture-noindex.php`
  (the folder is mounted as `wp-content/mu-plugins`)

Use `127.0.0.1` for the site, as everything here does (`WP_HOME`, the e2e checks). The SSRF-safe
fetcher now falls back from `::1` to `127.0.0.1` when `localhost` refuses on IPv6, but there's no
reason to change.

Then, with Core and the worker running:

1. Log in at http://127.0.0.1:8080/wp-admin/ as `admin`.
2. Settings → Site Guardian → **Connect**. The status changes to "Connected".
3. Open http://127.0.0.1:8080/site-health-check/ and chat, or open **Link Scanner** and click
   **Scan All Links**.

`docker compose down` stops WordPress; add `-v` to delete its database and files too.

## 5. Tests

```sh
pnpm typecheck && pnpm lint
pnpm test                      # unit tests (*.test.ts) + plugin JS tests (jsdom)
pnpm test:integration          # *.int.test.ts, needs `supabase start`
(cd plugin && vendor/bin/phpunit && vendor/bin/phpcs)
pnpm --filter e2e test         # Stage 1 and Stage 2 end-to-end checks
```

The e2e checks need local Supabase and the WordPress stack with its fixtures (steps 2 and 4), with
nothing else listening on port 8787 and no other worker running: they build Core and the worker
and start and stop both themselves (`AI_STUB=true`, `ALLOW_LOCAL_SITES=true`). Before running,
they reset the plugin's connection options, the local registration rate limits, and the local
site's link scans and scan rate limits (only on a local database). The files run in order in one
Playwright run: `stage1.spec.ts` connects the site, then `stage2.spec.ts` scans it (it connects
the site itself when run alone). Checks that need internet access: Stage 1 registers
`https://example.com`, and the link scan fetches it.

The Stage 2 "worker killed mid-scan" check takes one to two minutes: it kills the worker with
SIGKILL and waits for pg-boss to notice the lost heartbeat (`heartbeatSeconds` in
`LINK_SCAN_QUEUE_OPTIONS`) and retry the job.
