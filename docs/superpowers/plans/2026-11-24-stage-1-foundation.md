# Stage 1 — Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A working monorepo where a WordPress plugin connects to Core by proving it owns its domain, and a logged-in admin can chat with the AI through Core. Every security rule in the spec is in place from the start.

**Architecture:** pnpm monorepo. `packages/shared` holds the zod contracts and the SSRF-safe fetcher. `apps/core` is an Express API backed by Supabase (supabase-js for data, a `pg` pool for rate limits). `apps/worker` is an empty buildable shell. `plugin/` is a namespaced, Composer-autoloaded WordPress plugin that proxies every browser action through its own capability-gated REST routes.

**Tech Stack:** Node 22, TypeScript (strict), pnpm workspaces, Express 4, zod, pino, helmet, rate-limiter-flexible (Postgres store), @anthropic-ai/sdk, Vitest + supertest, Supabase CLI (local Postgres), PHP 8.1+, Composer, PHPUnit + Brain Monkey, PHPCS (WPCS), DOMPurify (vendored), Playwright (e2e), Docker Compose.

**Spec:** `docs/superpowers/specs/2026-11-24-site-guardian-rebuild-design.md` (approved). Read §5–§8 and §10 before starting any task.

**Reference only (do not copy blindly):** `../site-guardian-ai/` (old plugin; UI source for Task 13) and `../site-guardian-core/` (old Core; `supabase/migrations/0001_foundation.sql` is the base for Task 4).

## Global Constraints

- Node ≥ 22; PHP ≥ 8.1; WordPress ≥ 6.4. TypeScript `strict: true`.
- Plugin slug, folder and text domain: `site-guardian`. PHP namespace `SiteGuardian\`.
- Plugin REST namespace: `site-guardian/v1`. Core base path: `/api/v1`.
- Front-end page slug: `site-health-check`, `noindex`.
- Default capability `manage_options`, filter `site_guardian_capability`.
- Constants: `SITE_GUARDIAN_CORE_URL` (default `https://core.siteguardian.ai/api/v1`), optional `SITE_GUARDIAN_CREDENTIAL`.
- Credential format: `sgat_` + 64 hex chars (32 random bytes). Core stores only its SHA-256 hash.
- Registration challenge: random, single use, TTL 10 minutes.
- safe-fetch: `http`/`https` only, ports 80/443, max 5 redirects, each hop re-validated, connects to the resolved IP.
- Chat history: the last 20 turns, rebuilt by Core from `ai_messages`. The client sends only `message` + `conversation_id`.
- Error shape: `{ error: { code, message }, request_id }`.
- No `admin-ajax.php`, no `nopriv` handlers, no secret passed to the browser except the WP REST nonce.
- Anthropic: model from `ANTHROPIC_MODEL`, default `claude-opus-5-5`; `output_config.effort: "low"` for chat; server-side refusal fallback (`betas: ["server-side-fallback-2026-07-01"]`, `fallbacks: "default"`). Check `stop_reason` before reading content.
- Clean start: no migration from the old plugin or old Core data.
- Commit after every task. Commit trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.

## Review Focus

1. **Messy `site_url` inputs** (`https://Example.COM:443/blog/`, trailing dots, IDN) — they must normalize to one origin so the same site never gets two rows. Test in Task 2.
2. **Core unreachable or slow during Connect** — the plugin shows a retry with a clear message, and no half-stored credential is left behind. Test in Task 10.
3. **Replaying a used or expired challenge** — it must be rejected, even if the verify URL still serves it. Test in Task 6.
4. **The WP REST nonce expires on a long-open chat page** — the UI shows "Your session expired — please refresh" instead of failing silently. Test in Task 13.
5. **Anthropic down, rate-limited, or refusing** — the user gets a friendly message and a `502 ai_unavailable`, and their message is still stored so the history stays consistent. Test in Task 7.

---

### Task 1: Monorepo skeleton

**Files:**
- Create: `package.json`, `pnpm-workspace.yaml`, `tsconfig.base.json`, `eslint.config.js`, `vitest.workspace.ts`, `.gitignore`, `.nvmrc` (`22`), `.editorconfig`, `README.md`
- Create: `packages/shared/{package.json,tsconfig.json,src/index.ts}`, `apps/core/{package.json,tsconfig.json,src/index.ts}`, `apps/worker/{package.json,tsconfig.json,src/index.ts}`
- Test: `packages/shared/src/index.test.ts`

**Interfaces:**
- Produces: root scripts `pnpm typecheck`, `pnpm lint`, `pnpm test`, `pnpm build`, `pnpm test:integration`. Workspace package names `@sg/shared`, `@sg/core`, `@sg/worker`.

- [ ] **Step 1:** Write `packages/shared/src/index.test.ts`: `it("exports VERSION", () => expect(VERSION).toBe("0.1.0"))`.
- [ ] **Step 2:** Run `pnpm install && pnpm test`. Expected: FAIL (VERSION not exported).
- [ ] **Step 3:** Create the workspace files. `apps/worker/src/index.ts` logs `"worker idle — no jobs in Stage 1"` and exits 0. Unit tests are named `*.test.ts`. Integration tests are named `*.int.test.ts`, are excluded from `pnpm test`, and run with `pnpm test:integration`. The README covers prerequisites (Node 22, pnpm, Docker, Supabase CLI) and the local-dev steps that Tasks 4 and 14 complete.
- [ ] **Step 4:** Run `pnpm typecheck && pnpm lint && pnpm test && pnpm build`. Expected: all pass.
- [ ] **Step 5:** Commit `chore: monorepo skeleton`.

### Task 2: Shared contracts

**Files:**
- Create: `packages/shared/src/contracts/{errors.ts,sites.ts,chat.ts,config.ts,index.ts}`, `packages/shared/src/origin.ts`
- Test: `packages/shared/src/origin.test.ts`, `packages/shared/src/contracts/contracts.test.ts`

**Interfaces:**
- Produces:
  - `normalizeOrigin(url: string): string`. Throws `InvalidOriginError` on non-http(s), credentials in the URL, or IP-literal hosts in production mode (`normalizeOrigin(url, { allowIpHosts?: boolean })`).
  - zod schemas, each `.strict()`, plus inferred types:
    - `RegisterStartRequest {installation_id: uuid, site_url: url≤2048, site_name?≤255, wp_version?≤32, plugin_version?≤32, php_version?≤32}` → `RegisterStartResponse {challenge_id: uuid, challenge: string, expires_at: iso}`
    - `RegisterCompleteRequest {challenge_id: uuid}` → `RegisterCompleteResponse {website_id: uuid, credential: string, plan_code: string}`
    - `RotateResponse {credential: string}`
    - `ConfigResponse {config: Record<string, unknown>, website: {id, status}}`
    - `ChatRequest {message: 1..4000, conversation_id?: uuid}` → `ChatResponse {reply: string, conversation_id: uuid}`
  - `ErrorBody` and the error-code union `"bad_request"|"unauthorized"|"forbidden"|"not_found"|"rate_limited"|"verification_failed"|"ai_unavailable"|"internal"`.
  - Header constant `USER_REF_HEADER = "x-sg-user-ref"`. Value schema: 64 hex chars.

- [ ] **Step 1: Write the failing tests**

```ts
expect(normalizeOrigin("https://Example.COM:443/blog/")).toBe("https://example.com");
expect(normalizeOrigin("http://example.com:80")).toBe("http://example.com");
expect(normalizeOrigin("https://example.com.")).toBe("https://example.com");
expect(normalizeOrigin("https://bücher.de")).toBe("https://xn--bcher-kva.de");
expect(normalizeOrigin("https://example.com:8443")).toBe("https://example.com:8443");
expect(() => normalizeOrigin("ftp://example.com")).toThrow(InvalidOriginError);
expect(() => normalizeOrigin("https://u:p@example.com")).toThrow(InvalidOriginError);
expect(() => normalizeOrigin("http://127.0.0.1")).toThrow(InvalidOriginError);
expect(normalizeOrigin("http://127.0.0.1:8080", { allowIpHosts: true })).toBe("http://127.0.0.1:8080");
// contracts
expect(ChatRequest.safeParse({ message: "hi", history: [] }).success).toBe(false); // history rejected
expect(ChatRequest.safeParse({ message: "" }).success).toBe(false);
expect(RegisterStartRequest.safeParse({ installation_id: "x", site_url: "https://a.com" }).success).toBe(false);
```

- [ ] **Step 2:** Run `pnpm --filter @sg/shared test`. Expected: FAIL.
- [ ] **Step 3:** Implement `origin.ts` using WHATWG `URL`. Implement the schemas.
- [ ] **Step 4:** Run tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(shared): API contracts and origin normalization`.

### Task 3: SSRF-safe fetcher

**Files:**
- Create: `packages/shared/src/safe-fetch/{ip-policy.ts,safe-fetch.ts,index.ts}`
- Test: `packages/shared/src/safe-fetch/ip-policy.test.ts`, `safe-fetch.test.ts`

**Interfaces:**
- Produces:
  - `isBlockedAddress(ip: string): boolean`
  - `safeFetch(url: string, opts?: SafeFetchOptions): Promise<SafeFetchResponse>`
  - `SafeFetchOptions {method?: "GET"|"HEAD"; maxRedirects?: number (default 5); timeoutMs?: number (default 10000); maxBytes?: number (default 1_048_576); allowedPorts?: number[] (default [80,443]); allowPrivate?: boolean (default false); resolver?: (host) => Promise<string[]>; headers?: Record<string,string>}`
  - `SafeFetchResponse {status: number; finalUrl: string; headers: Record<string,string>; body: string; truncated: boolean}`
  - `SafeFetchError` with `code: "blocked_address"|"bad_scheme"|"bad_port"|"too_many_redirects"|"timeout"|"dns_failed"`.

- [ ] **Step 1: Write the failing tests**

```ts
for (const ip of ["127.0.0.1","10.1.2.3","172.16.0.1","192.168.1.1","169.254.169.254","100.64.0.1","0.0.0.0","224.0.0.1","::1","fe80::1","fc00::1","::ffff:127.0.0.1","::ffff:10.0.0.1"])
  expect(isBlockedAddress(ip)).toBe(true);
for (const ip of ["93.184.216.34","2606:2800:220:1::1"]) expect(isBlockedAddress(ip)).toBe(false);

// resolver injected; local http server bound on 127.0.0.1 with allowPrivate used only where noted
await expect(safeFetch("http://evil.test/", { resolver: async () => ["169.254.169.254"] })).rejects.toMatchObject({ code: "blocked_address" });
await expect(safeFetch("file:///etc/passwd")).rejects.toMatchObject({ code: "bad_scheme" });
await expect(safeFetch("http://example.com:22/")).rejects.toMatchObject({ code: "bad_port" });
// redirect public→private: server A (allowPrivate for A's own hop via resolver map) 302s to http://internal.test, which resolves to 10.0.0.5
await expect(/* ... */).rejects.toMatchObject({ code: "blocked_address" });
// 6 chained redirects → too_many_redirects; slow server → timeout; 2MB body → truncated: true
// rebinding: resolver returns ["93.184.216.34"] first then ["127.0.0.1"]; assert connection used the first (pinned) address
```

- [ ] **Step 2:** Run tests. Expected: FAIL.
- [ ] **Step 3:** Implement with `undici` `Agent` and a custom `connect.lookup` that returns the already-validated pinned IP. Do redirects manually (`redirect: "manual"`). Use an `AbortSignal` for timeouts. Stream the body and cut it off at `maxBytes`. Never forward cookies or `authorization` across redirects.
- [ ] **Step 4:** Run tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(shared): SSRF-safe fetcher`.

### Task 4: Database migration

**Files:**
- Create: `supabase/config.toml` (via `supabase init`), `supabase/migrations/20261124000001_foundation.sql`, `supabase/seed.sql`
- Test: `supabase/tests/foundation.int.test.ts` (run from `apps/core` integration suite) — or `supabase/tests/*.sql` with pgTAP (builder's choice)

**Interfaces:**
- Produces these tables, ported from the old `0001_foundation.sql` with the changes below:
  - `websites`: add `origin text not null unique`. `installation_id` is no longer unique (indexed only). Add `credential_rotated_at timestamptz`.
  - New `registration_challenges(id uuid pk, installation_id uuid, origin text, site_url text, site_name text, wp_version text, plugin_version text, php_version text, challenge_hash text not null, expires_at timestamptz not null, used_at timestamptz, created_at)`.
  - `ai_conversations` and `audit_logs`: add `wp_user_ref text`. `ai_conversations` index `(website_id, wp_user_ref, updated_at desc)`.
  - `sg_apply_credit_transaction()` and the plans seed kept as-is.
  - Rate-limit table created by rate-limiter-flexible, or pre-created as `rate_limits` (builder's choice; it must be in a migration, not auto-created at runtime in production).
  - `alter table … enable row level security` on **every** table, with no policies.

- [ ] **Step 1:** Write the integration test. It connects as `anon` with the local anon key and asserts that `select` on each table returns 0 rows or a permission error, and that `insert into websites` fails. As service role it asserts that `sg_apply_credit_transaction` with an amount that would go negative raises, and that two inserts into `websites` with the same `origin` fail.
- [ ] **Step 2:** Run `supabase start && pnpm test:integration -t foundation`. Expected: FAIL (no tables).
- [ ] **Step 3:** Write the migration and seed (seed: the plans rows only).
- [ ] **Step 4:** Run `supabase db reset && pnpm test:integration -t foundation`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(db): foundation schema with RLS`.

### Task 5: Core app skeleton

**Files:**
- Create: `apps/core/src/{config.ts,app.ts,server.ts}`, `src/lib/{errors.ts,logger.ts,db.ts,supabase.ts,audit.ts,rate-limit.ts}`, `src/middleware/{request-id.ts,error-handler.ts}`, `src/routes/health.ts`, `apps/core/.env.example`, `apps/core/Dockerfile`
- Test: `apps/core/src/app.test.ts`, `src/config.test.ts`

**Interfaces:**
- Produces:
  - `loadConfig(env: NodeJS.ProcessEnv): Config`, validated with zod. Required: `SUPABASE_URL`, `SUPABASE_SERVICE_ROLE_KEY`, `DATABASE_URL`, `ANTHROPIC_API_KEY`, `CORE_PUBLIC_URL`. Optional: `PORT` (8787), `ANTHROPIC_MODEL` (`claude-opus-5-5`), `ALLOW_LOCAL_SITES` (false; **throws if true while `NODE_ENV=production`**), `CORS_ALLOWED_ORIGINS`.
  - `createApp(deps: AppDeps): express.Express` with `AppDeps {config: Config; supabase: SupabaseClient; pool: pg.Pool; ai: AiClient; fetcher: typeof safeFetch; now?: () => Date}`.
  - `ApiError` with statics `badRequest | unauthorized | forbidden | notFound | rateLimited | verificationFailed | aiUnavailable | internal`.
  - `audit(deps, entry: {website_id?: string; wp_user_ref?: string; action: string; metadata?: object; ip?: string}): Promise<void>`. Never throws.
  - `limiter(pool, name, {points, durationSec}, key: (req) => string): RequestHandler`.

- [ ] **Step 1: Write failing tests:**
  - `GET /api/v1/health` → 200 `{status:"ok"}`
  - unknown route → 404 with `ErrorBody` and an `x-request-id` header
  - a thrown non-ApiError → 500 `{error:{code:"internal"}}` with no stack in the body
  - the `x-powered-by` header is absent
  - a JSON body over 256 KB → 413 with `ErrorBody`
  - a request with `Origin: https://evil.test` gets no `access-control-allow-origin` header
  - `loadConfig({...valid, NODE_ENV:"production", ALLOW_LOCAL_SITES:"true"})` throws
  - `loadConfig` without `ANTHROPIC_API_KEY` throws
  - a logger test asserting that `authorization` and `credential` fields are redacted
- [ ] **Step 2:** Run `pnpm --filter @sg/core test`. Expected: FAIL.
- [ ] **Step 3:** Implement. `server.ts` is the only file that reads `process.env` and calls `listen`.
- [ ] **Step 4:** Run tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): app skeleton, config, errors, logging`.

### Task 6: Site registration, credential and auth middleware

**Files:**
- Create: `apps/core/src/lib/credential.ts`, `src/middleware/site-auth.ts`, `src/routes/sites.ts`, `src/routes/config.ts`
- Test: `src/routes/sites.int.test.ts`, `src/lib/credential.test.ts`, `src/middleware/site-auth.int.test.ts`

**Interfaces:**
- Consumes: Task 2 contracts, Task 3 `safeFetch`, Task 5 `createApp`, `audit`, `limiter`.
- Produces:
  - `generateCredential(): {token, hash}`, `hashToken(token): string`, `generateChallenge(): {value, hash}`
  - `requireSite: RequestHandler`. It sets `req.website: {id, origin, planCode, status}` and `req.wpUserRef?: string` (from `USER_REF_HEADER`, validated; an invalid value → 400). It rejects `suspended`/`revoked` with 403.
  - Routes:
    - `POST /sites/register/start` (public; limiter 20/hour/IP)
    - `POST /sites/register/complete` (public; limiter 20/hour/IP)
    - `POST /sites/credential/rotate` (requireSite)
    - `GET /config` (requireSite)
  - Verify URLs Core fetches, in order: `{origin}/wp-json/site-guardian/v1/verify/{challenge_id}`, then `{origin}/?site_guardian_verify={challenge_id}`. Expected response body: JSON `{"challenge": "<value>"}`, status 200.

- [ ] **Step 1: Write failing integration tests** (local Supabase; `fetcher` stubbed per test):
  - start → 201 with challenge. The DB stores only `challenge_hash`. `expires_at` = now + 10 min.
  - complete where the stub returns the right challenge → 201. The credential matches `/^sgat_[0-9a-f]{64}$/`. The DB holds the hash, not the token. A `websites` row with a normalized origin is created, plus a `credit_balances` row and a `site.registered` audit row.
  - complete with the wrong challenge value → 400 `verification_failed`. No website row.
  - REST URL 404 and fallback URL correct → success (fallback works).
  - **Replay:** a second complete with the same `challenge_id` → 400 `verification_failed`.
  - **Expired:** `now` advanced by 11 min → 400 `verification_failed`.
  - Fetcher throws `blocked_address` → 400 `verification_failed`. The message mentions the site couldn't be reached.
  - Same origin + same installation re-verified → 200, same `website_id`, the old token now returns 401.
  - Same origin + **different** installation → 200, same `website_id` (domain proof wins), audit `site.credential_rotated`.
  - New origin, same installation → a new `website_id`.
  - `ALLOW_LOCAL_SITES=false` and `site_url` `http://localhost:8080` → start returns 400.
  - rotate with a valid bearer → new token, old one 401. Without a bearer → 401.
  - `GET /config` with a revoked site → 403. With a valid one → 200 and its `website.id`.
  - The 21st start from one IP within the hour → 429 `rate_limited`.
- [ ] **Step 2:** Run `pnpm test:integration -t sites`. Expected: FAIL.
- [ ] **Step 3:** Implement. Mark the challenge `used_at` inside the same statement that checks it is unused and unexpired (`update … where used_at is null and expires_at > now() returning *`), so a concurrent replay can't win. With `ALLOW_LOCAL_SITES`, pass `allowPrivate: true` and `allowIpHosts: true` to fetcher and origin.
- [ ] **Step 4:** Run tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): domain-verified registration and site auth`.

### Task 7: AI chat

**Files:**
- Create: `apps/core/src/lib/ai.ts`, `src/lib/prompts.ts`, `src/routes/chat.ts`
- Test: `src/routes/chat.int.test.ts`, `src/lib/ai.test.ts`

**Interfaces:**
- Consumes: `requireSite`, `limiter`, contracts.
- Produces:
  - `interface AiClient { reply(input: {system: string; messages: Anthropic.MessageParam[]}): Promise<string> }`
  - `createAnthropicAi(config): AiClient`, which uses `@anthropic-ai/sdk` `client.beta.messages.create` with `model`, `max_tokens: 16000`, `output_config: {effort: "low"}`, `betas: ["server-side-fallback-2026-07-01"]`, `fallbacks: "default"`, and SDK `timeout: 60_000`. It returns the joined `text` blocks. It throws `ApiError.aiUnavailable()` on `stop_reason === "refusal"` with no text, on `RateLimitError`, `APIConnectionError`, or 5xx (catch from most specific to least).
  - `buildSystemPrompt(siteName: string, origin: string): string`. Port the old `buildSystemPrompt` rules verbatim, and add rule 7: *"Scans (links, layout, speed, remote scan) are not available yet. If asked to run or explain one, say warmly that this check is coming soon, in one or two sentences."*
  - `POST /ai/chat` (requireSite; limiter 20/min per website+userRef). It requires the `USER_REF_HEADER` header (400 if missing).

- [ ] **Step 1: Write failing tests** (stub `AiClient`):
  - A new conversation is created, scoped to website + `wp_user_ref`. Response 200 `{reply, conversation_id}`.
  - Second call with `conversation_id`: the stub receives the prior turns from the DB, in order, capped at the last 20.
  - A `conversation_id` that belongs to another website or another `wp_user_ref` → a new conversation (not an error, no leak).
  - A body with a `history` field → 400.
  - Stub throws `aiUnavailable` → 502 `{error:{code:"ai_unavailable", message: friendly}}`, and the user message **is** stored.
  - The system prompt contains the site origin and the "coming soon" rule.
  - Unit (`ai.test.ts`, mocked SDK): a refusal with no text → `aiUnavailable`. Text blocks are joined. A thinking block is ignored.
- [ ] **Step 2:** Run tests. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run tests. Expected: PASS.
- [ ] **Step 5:** Commit `feat(core): AI chat with server-side history`.

### Task 8: Worker shell and container images

**Files:**
- Modify: `apps/worker/src/index.ts`. Create: `apps/worker/Dockerfile`
- Test: `apps/worker/src/index.test.ts`

**Interfaces:**
- Produces: `startWorker(config): Promise<{stop(): Promise<void>}>`, a no-op loop that logs it is idle. Stage 2 adds pg-boss here.

- [ ] **Step 1:** Test: `startWorker` resolves and `stop()` resolves.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. Both Dockerfiles are multi-stage, build with pnpm, and run as a non-root user.
- [ ] **Step 4:** Run `pnpm test && docker build -f apps/core/Dockerfile . && docker build -f apps/worker/Dockerfile .`. Expected: pass.
- [ ] **Step 5:** Commit `feat(worker): idle worker shell and Dockerfiles`.

### Task 9: Plugin skeleton and credential store

**Files:**
- Create: `plugin/site-guardian.php`, `plugin/composer.json`, `plugin/phpcs.xml.dist`, `plugin/phpunit.xml.dist`, `plugin/uninstall.php`, `plugin/readme.txt`, `plugin/src/Plugin.php`, `plugin/src/Core/CredentialStore.php`, `plugin/src/Support/Options.php`
- Test: `plugin/tests/Unit/CredentialStoreTest.php`, `plugin/tests/bootstrap.php`

**Interfaces:**
- Produces:
  - `Plugin::boot(string $file): void`, which wires the hooks for every module (later tasks register theirs here).
  - `Options` constants: `INSTALLATION_ID = 'site_guardian_installation_id'`, `WEBSITE_ID = 'site_guardian_website_id'`, `CREDENTIAL = 'site_guardian_credential'`, `USER_REF_SECRET = 'site_guardian_user_ref_secret'`, `PENDING_CHALLENGE = 'site_guardian_pending_challenge'` (array `{id, value, expires}`), `CAPABILITY = 'site_guardian_capability'`, `LAST_ERROR = 'site_guardian_last_error'`, `PAGE_ID = 'site_guardian_page_id'`. All set with autoload off.
  - `CredentialStore::get(): ?string` (returns the `SITE_GUARDIAN_CREDENTIAL` constant if defined; on a decrypt failure deletes the option and returns null), `::put(string $token): void`, `::clear(): void`. Encryption: `sodium_crypto_secretbox`, key = `sodium_crypto_generichash(AUTH_KEY . AUTH_SALT . 'site-guardian', '', 32)`, stored `base64(nonce . ciphertext)`.
  - `uninstall.php` deletes every `Options` constant and the page stored in `PAGE_ID`.

- [ ] **Step 1: Write failing tests** (Brain Monkey stubbing `get_option`/`update_option`/`delete_option`):
  - put → get round-trips.
  - The stored option value doesn't contain the token.
  - get with a different `AUTH_KEY` → null and the option is deleted (clone case).
  - get when the constant is defined → the constant's value.
- [ ] **Step 2:** Run `composer install && vendor/bin/phpunit`. Expected: FAIL.
- [ ] **Step 3:** Implement. The plugin header requires PHP 8.1 and WP 6.4. `Plugin::boot` exits early with an admin notice if `sodium` is missing.
- [ ] **Step 4:** Run `vendor/bin/phpunit && vendor/bin/phpcs`. Expected: PASS, no PHPCS errors.
- [ ] **Step 5:** Commit `feat(plugin): skeleton and encrypted credential store`.

### Task 10: Plugin ↔ Core client, registration, verify route

**Files:**
- Create: `plugin/src/Core/Client.php`, `plugin/src/Core/Registration.php`, `plugin/src/Core/UserRef.php`, `plugin/src/Rest/VerifyController.php`
- Test: `plugin/tests/Unit/{ClientTest,RegistrationTest,UserRefTest,VerifyControllerTest}.php`

**Interfaces:**
- Consumes: Task 2 contract shapes (as PHP arrays), `CredentialStore`, `Options`.
- Produces:
  - `Client::base_url(): string` (constant or the default; no filter, no option).
  - `Client::request(string $method, string $path, array $body = [], bool $auth = true): Result`. Timeout 15s, `sslverify` true. When `$auth` is set it sends `Authorization: Bearer` and `x-sg-user-ref` for the current user.
  - `Result {bool $ok; int $status; array $data; ?string $error_code; ?string $message}`.
  - `UserRef::for_user(int $user_id): string` = `hash_hmac('sha256', (string)$user_id, secret)`. The secret is generated once and stored in `USER_REF_SECRET`.
  - `Registration::connect(): Result`, which runs start → store pending challenge → complete → `CredentialStore::put`, then clears the pending challenge. On any failure it stores `LAST_ERROR` and **does not** store a credential. `Registration::rotate(): Result`. `Registration::is_connected(): bool`.
  - Public route `GET site-guardian/v1/verify/(?P<id>[0-9a-f-]{36})` (permission `__return_true`). It returns `{"challenge": value}` only if `id` matches the unexpired pending challenge, otherwise 404. Also `template_redirect`: if the `site_guardian_verify` query var matches, it prints the same JSON with `nocache_headers()` and exits.

- [ ] **Step 1: Write failing tests:**
  - `connect()` happy path (stubbed `wp_remote_request`): the credential is stored and the pending challenge cleared.
  - **Core unreachable** (`WP_Error` on start) → `ok=false`, `LAST_ERROR` set, `CredentialStore::get()` null.
  - Core is reachable at start but complete returns 400 → no credential stored, and the message is passed through.
  - Verify route: matching id → 200 with value. Wrong id → 404. Expired → 404. Query-var fallback matches.
  - `UserRef` is stable for the same user and differs across users.
  - The request sends no `x-sg-user-ref` when there is no logged-in user.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run `vendor/bin/phpunit && vendor/bin/phpcs`. Expected: PASS.
- [ ] **Step 5:** Commit `feat(plugin): Core client and domain-verified registration`.

### Task 11: Settings page and Connect flow

**Files:**
- Create: `plugin/src/Admin/SettingsPage.php`, `plugin/src/Admin/Notices.php`, `plugin/src/Rest/AdminController.php`, `plugin/src/Frontend/Access.php` (only `capability()` for now), `plugin/assets/admin/settings.js`, `plugin/assets/admin/settings.css`
- Test: `plugin/tests/Unit/AdminControllerTest.php`

**Interfaces:**
- Consumes: `Registration`.
- Produces:
  - `Access::capability(): string` = `apply_filters('site_guardian_capability', get_option(CAPABILITY, 'manage_options'))`.
  - Routes (all require the `manage_options` capability + `wp_rest` nonce):
    - `POST site-guardian/v1/admin/connect` → `{connected: bool, message: string}`
    - `POST …/admin/rotate`
    - `GET …/admin/status` → `{connected, website_id, core_url, last_error}`
  - Settings page under Settings → Site Guardian:
    - connection status
    - a "Connect" button (with progress and a retry on failure)
    - "Rotate credential"
    - a capability dropdown (`manage_options`, `edit_pages`, `edit_posts`), saved via the Settings API with sanitize and a whitelist
    - the Core URL shown read-only
  - Admin notice after activation while not connected, linking to the page.

- [ ] **Step 1:** Write failing tests: each route's `permission_callback` returns false for a user without `manage_options`. Connect returns the `Registration` result. The capability sanitizer rejects `do_anything`.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement. The admin JS uses `textContent` for every message.
- [ ] **Step 4:** Run tests and PHPCS. Expected: PASS.
- [ ] **Step 5:** Commit `feat(plugin): settings page and connect flow`.

### Task 12: Owner-only front-end page and chat proxy

**Files:**
- Create: `plugin/src/Frontend/Page.php`, `plugin/src/Frontend/Template.php`, `plugin/src/Rest/ChatController.php`, `plugin/templates/app.php`
- Modify: `plugin/src/Frontend/Access.php` (add `gate()`)
- Test: `plugin/tests/Unit/{PageTest,AccessTest,ChatControllerTest}.php`

**Interfaces:**
- Consumes: `Client`, `Access::capability()`.
- Produces:
  - `Page::ensure(): int`: create, dedupe (keep the lowest ID, trash the others), recreate if deleted. Runs on activation and `admin_init`. The slug is `site-health-check`.
  - `Access::gate()` on `template_redirect` for that page: logged out → `auth_redirect()`. Lacking the capability → `status_header(404)` + the theme 404 template. It also sends `X-Robots-Tag: noindex` and the CSP header `default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'self'; form-action 'self'`.
  - `Template`: theme-free template (port from the old `class-sga-template.php` / `clean-page.php`) rendering `templates/app.php`. Boot data goes in `<div id="sg-app" data-rest-url="…" data-nonce="…" data-site-name="…">`. No inline script.
  - `POST site-guardian/v1/chat` (capability + nonce) → forwards `{message, conversation_id}` to Core `/ai/chat` and returns Core's JSON and status unchanged. A Core error returns its `ErrorBody` with the same status.
  - `GET site-guardian/v1/conversation` → the stored `conversation_id` for the current user (user meta `site_guardian_conversation_id`). The chat route updates that meta.

- [ ] **Step 1: Write failing tests:**
  - `ensure()` with two existing pages trashes the newer one. With none, it creates one.
  - Gate: guest → `auth_redirect` called. Subscriber → 404. Admin → passes and sends the CSP header.
  - Chat route permission false for a subscriber.
  - Chat forwards only `message` + `conversation_id`. Extra fields from the browser are dropped.
  - A Core 502 is passed through as 502.
- [ ] **Step 2:** Run. Expected: FAIL.
- [ ] **Step 3:** Implement.
- [ ] **Step 4:** Run tests and PHPCS. Expected: PASS.
- [ ] **Step 5:** Commit `feat(plugin): owner-only page and chat proxy`.

### Task 13: UI port

**Files:**
- Create: `plugin/assets/css/{chat,link-scanner,layout-check,remote-scan}.css` (copied unchanged from `../site-guardian-ai/assets/css/`), `plugin/assets/vendor/purify.min.js` (DOMPurify 3.x, with its license), `plugin/assets/js/{app.js,api.js,render.js,markdown.js,screens/chat.js,screens/coming-soon.js}`, `plugin/package.json` (dev-only: vitest + jsdom for these tests)
- Modify: `plugin/templates/app.php` (port the markup of `chat-page.php`, `link-scanner.php` and `remote-scan.php` as tabs/sections, the same as the old layout)
- Test: `plugin/assets/js/__tests__/{render.test.js,api.test.js}`

**Interfaces:**
- Consumes: the boot data attributes and REST routes from Task 12.
- Produces:
  - `api.js`: `postChat(message, conversationId): Promise<ChatResponse>`. It throws `SessionExpiredError` on 403 `rest_cookie_invalid_nonce` / `rest_forbidden`, and `ApiFailure(code, message)` otherwise.
  - `render.js`: `renderAssistant(el, markdown)` (markdown → HTML → `DOMPurify.sanitize` → insert) and `renderText(el, text)` (`textContent`). **No other `innerHTML` with dynamic data anywhere.**
  - `markdown.js`: a minimal markdown converter (ported from `markdownToHtml` in the old `chat.js`).
  - The chat screen keeps the look and behaviour of the old `chat.js` chat flow: bubbles, typing indicator, intro message. The keyword-triggered scan cards are not ported. The link, layout and remote screens render with the old markup and a "Coming soon" state.

- [ ] **Step 1: Write failing tests** (jsdom):
  - `renderAssistant(el, "hi <img src=x onerror=alert(1)>")` → no `onerror` attribute and no `<script>` in `el.innerHTML`.
  - `renderAssistant(el, "**bold**")` → contains `<strong>bold</strong>`.
  - `renderText(el, "<b>x</b>")` → `el.textContent === "<b>x</b>"` and `el.children.length === 0`.
  - `postChat` with a mocked fetch returning 403 `{code:"rest_cookie_invalid_nonce"}` → rejects with `SessionExpiredError`.
  - The chat screen shows "Your session expired — please refresh the page." on `SessionExpiredError`.
  - `ai_unavailable` → shows Core's friendly message.
  - A grep test: no file under `assets/js` (excluding `vendor/`) matches `/innerHTML\s*=\s*[^'"`]/` outside `render.js`.
- [ ] **Step 2:** Run `pnpm --dir plugin test`. Expected: FAIL.
- [ ] **Step 3:** Implement. Load the scripts as `type="module"` via `wp_enqueue_script_module` (WP ≥ 6.5) or a `script_loader_tag` filter adding `type="module"` (builder's choice; it must stay CSP-compatible).
- [ ] **Step 4:** Run tests. Expected: PASS. Open the page in the Task 14 environment and visually compare it with the old plugin.
- [ ] **Step 5:** Commit `feat(plugin): port UI with XSS-safe rendering`.

### Task 14: Local environment and end-to-end checks

**Files:**
- Create: `docker-compose.yml` (wordpress:php8.2 + mysql 8 + wp-cli. `plugin/` mounted at `wp-content/plugins/site-guardian`. `SITE_GUARDIAN_CORE_URL` set to `http://host.docker.internal:8787/api/v1` via `WORDPRESS_CONFIG_EXTRA`), `scripts/dev-setup.sh` (installs WP, creates an admin and a subscriber, activates the plugin), `e2e/{package.json,playwright.config.ts,stage1.spec.ts}`
- Modify: `README.md` (full local-dev walkthrough)

**Interfaces:**
- Consumes: everything above. Core runs locally with `ALLOW_LOCAL_SITES=true`. The Anthropic key is real or a stub, selected with `AI_STUB=true`. `AI_STUB` is added in `server.ts` and is refused when `NODE_ENV=production`.

- [ ] **Step 1: Write `stage1.spec.ts`** with the spec §8 "Done when" checks:
  1. The admin logs in, goes to Settings → Site Guardian, clicks Connect, and sees "Connected".
  2. The admin opens `/site-health-check`, sends "hello", and gets an assistant reply bubble.
  3. A logged-out visit to `/site-health-check` → lands on `wp-login.php`.
  4. The subscriber visits → 404.
  5. With Core stopped, Connect shows the error and a Retry button.
  6. A direct `POST /api/v1/sites/register/start` + `complete` for `https://example.com` (not ours) → `verification_failed`.
- [ ] **Step 2:** Run `docker compose up -d && scripts/dev-setup.sh && pnpm --filter e2e test`. Expected: FAIL before the wiring is finished, PASS after.
- [ ] **Step 3:** Fix whatever the e2e run exposes. Each fix gets a unit test in the owning package.
- [ ] **Step 4:** Run the full gate: `pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration && (cd plugin && vendor/bin/phpunit && vendor/bin/phpcs) && pnpm --filter e2e test`. Expected: all pass.
- [ ] **Step 5:** Commit `test: Stage 1 end-to-end checks and local environment`.
