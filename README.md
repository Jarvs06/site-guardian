# Site Guardian

pnpm monorepo:

| Path | What |
|---|---|
| `apps/core` | Core API (Express). The only component that holds secrets and talks to Anthropic and Supabase. |
| `apps/worker` | Background worker (an idle shell in Stage 1; jobs arrive in Stage 2). |
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

## 4. Local WordPress

```sh
docker compose up -d       # WordPress (http://127.0.0.1:8080) + MySQL
scripts/dev-setup.sh       # installs WordPress, creates users, activates the plugin (idempotent)
```

Users: `admin` / `admin-pass-local` (administrator), `sub` / `sub-pass-local` (subscriber).
The plugin directory is mounted into the container read-only, so PHP and JS edits show up
on reload. WordPress reaches Core on the host at `host.docker.internal:8787`.

Use `127.0.0.1`, not `localhost`, for the site: Core verifies the site by fetching it, and the
SSRF-safe fetcher connects only to the first resolved address. `localhost` resolves to `::1`
first, while Docker publishes the port on IPv4.

Then, with Core running:

1. Log in at http://127.0.0.1:8080/wp-admin/ as `admin`.
2. Settings → Site Guardian → **Connect**. The status changes to "Connected".
3. Open http://127.0.0.1:8080/site-health-check/ and chat.

`docker compose down` stops WordPress; add `-v` to delete its database and files too.

## 5. Tests

```sh
pnpm typecheck && pnpm lint
pnpm test                      # unit tests (*.test.ts) + plugin JS tests (jsdom)
pnpm test:integration          # *.int.test.ts, needs `supabase start`
(cd plugin && vendor/bin/phpunit && vendor/bin/phpcs)
pnpm --filter e2e test         # Stage 1 end-to-end checks
```

The e2e checks need local Supabase and the WordPress stack (steps 2 and 4), with nothing else
listening on port 8787: they build Core and start and stop it themselves (`AI_STUB=true`,
`ALLOW_LOCAL_SITES=true`). Before running, they reset the plugin's connection options and the
local registration rate limits. One check registers `https://example.com` and needs internet
access.
