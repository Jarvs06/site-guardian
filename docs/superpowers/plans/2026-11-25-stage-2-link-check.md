# Stage 2 — Link Check Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Owners click "Scan All Links" and get a background scan of every published page and every link on those pages, with progress, results, filters and CSV, run by Core's worker on a pg-boss queue.

**Architecture:** The plugin (PHP) builds the page list server-side and drives Core's `/scans` API. Core validates, stores and enqueues one pg-boss job per scan. The worker claims the job, fetches pages and links through safe-fetch with per-host limits, and writes `link_results` as it goes, resuming after a restart. The browser only starts, polls, cancels and reads through the plugin's REST proxy.

**Tech Stack:** pnpm monorepo, Node 22, TypeScript strict, Express, zod 4, pg + pg-boss, htmlparser2, Supabase Postgres, Vitest. WordPress plugin: PHP 8.1+, PHPUnit + Brain Monkey, plain ES modules (jsdom tests). Playwright e2e.

**Spec:** `docs/superpowers/specs/2026-11-25-stage-2-link-check-design.md`, built on `docs/superpowers/specs/2026-11-24-site-guardian-rebuild-design.md`. Read both. Section numbers below (§N) refer to the Stage 2 spec.

## Global Constraints

- Everything in the Stage 1 plan's Global Constraints and the ledger rulings in `docs/superpowers/plans/2026-11-24-stage-1-foundation.md` still holds. That includes ESM + NodeNext `.js` import suffixes, tests run only through root `pnpm test` / `pnpm test:integration`, and `*.int.test.ts` = integration.
- **Caps per scan:**
  - 1,000 pages and 5,000 unique links.
  - Page-list batches are 1–500 items.
  - One active scan per site and type. Active means `starting`, `queued` or `running`.
- **Concurrency:** at most 4 requests at a time to the site's own origin, 2 per external host, 16 external in total.
- **Time limits:**
  - Scan time budget: 20 minutes, then `completed` with `truncated_reason = 'time_limit'`.
  - A scan still `starting` 10 minutes after creation becomes `failed`.
  - pg-boss retries: 2.
- **Fetch limits:**
  - Pages: 15 s timeout, 2 MB body, up to 5 redirects.
  - Same-site links: body discarded after 64 KB.
  - External links: 10 s timeout, HEAD then GET on 405, 501 or a network failure.
- **Retention (§6):** after a completed scan, only it remains for that site. Creating a scan deletes earlier `cancelled` and `failed` scans.
- **Rate limits** (per site):
  - `POST /scans`: 10 per hour.
  - `/pages`: 30 per hour.
  - Reads: 1,200 per hour.
  - `cancel`: 30 per hour.
- **User-Agent:** `SiteGuardianBot/<VERSION> (+https://siteguardian.ai/bot)`. No cookies and no auth headers.
- **Status buckets and detail rules:** §8, verbatim. Link rows use `source = 'page'`, page rows use the post type.
- **Tracking parameters removed during normalization:** `dt, utm_source, utm_medium, utm_campaign, utm_term, utm_content, utm_id, fbclid, gclid, gad_source, gbraid, wbraid, mc_eid, _ga, _gl, ref, source, affiliate, partner, msclkid, twclid, li_fat_id, igshid, igsh`.
- **Excluded post types:**
  - `attachment, elementor_library, elementor-hf, popup_theme, popups, pum-popup, oembed_cache, wp_block, wp_template, wp_template_part, wp_global_styles, wp_navigation`.
  - Filter: `site_guardian_scan_excluded_post_types`.
- **Browser rendering:**
  - Scan-derived strings are never rendered as HTML.
  - Only `http:` and `https:` URLs become `href`s.
  - CSV cells starting with `=`, `+`, `-` or `@` get a leading `'`.
- **Commits:** commit after every task. Trailer: `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. PRs target `master`.

## Review Focus

1. **A page that redirects off the site's origin** (a permalink to another domain). The page row is `redirect` and its links are not extracted. The worker must never crawl another site's page as if it were the owner's. Tested in Task 7.
2. **A page that isn't small HTML** (PDF, image, a 2 MB+ HTML page). The page row is recorded (`ok` with null robots for non-HTML; `warning` "Page too large to read fully" for the body cap), with no crash and no links taken from the binary. Tested in Task 7.
3. **Messy `href`s:** relative `../x`, protocol-relative `//cdn.example/x`, `HTTP://Example.COM`, spaces, IDN hosts, `<base href>`, empty `href`. These resolve and normalize to one canonical URL each, or become `skipped` "Invalid link". They never throw. Tested in Task 6.
4. **The worker dies mid-scan and the job is retried.** No duplicate rows, counters match the rows, and the scan finishes. Tested in Task 8 (integration).
5. **An external host that hangs.** Its links end up `warning` (timeout) within the per-request timeout. Other hosts keep progressing, and the scan still completes inside its time budget. Tested in Task 7.

---

### Task 1: safe-fetch falls back to the next checked address (§9)

**Files:**
- Modify: `packages/shared/src/safe-fetch/safe-fetch.ts` (`validateHop` returns all checked IPs; `run` tries them in order)
- Test: `packages/shared/src/safe-fetch/safe-fetch.test.ts`

**Interfaces:**
- Produces: unchanged public API (`safeFetch(url, opts)`). New behaviour only.

- [ ] **Step 1: Write the failing tests.** Replace `"does not fall back to a later address when the first is unreachable"` with:
  - `"falls back to the next checked address when the first refuses"`: the resolver returns `["127.0.0.2", "127.0.0.1"]`, with a server only on 127.0.0.1 (`allowPrivate: true`). Expect body `"ok"` and `local.seen.length === 1`.
  - `"never falls back to an unchecked address"`: the resolver returns `["127.0.0.2", "10.0.0.5"]` with the real policy except loopback (`safeFetchWithPolicy(..., allowLoopbackOnly)`). Expect `blocked_address` and no connection.
  - `"does not retry another address after a response"`: two servers on 127.0.0.1 and 127.0.0.2 (if 127.0.0.2 isn't bindable on macOS, use a resolver that maps the same IP twice with a counter on the server). The first returns 503. Expect status 503 and exactly 1 request seen in total.
  - `"budget holds when every address hangs"`: the resolver returns `["192.0.2.1", "192.0.2.2"]` with `timeoutMs: 800`. Expect `timeout` or `network_error` within 2,000 ms.
  - Keep `"pins the connection to the FIRST validated address"` as is.
- [ ] **Step 2: Run** `pnpm exec vitest run --project unit packages/shared/src/safe-fetch/safe-fetch.test.ts`. Expected: the new fallback test fails (ECONNREFUSED → `network_error`). The others may pass.
- [ ] **Step 3: Implement.**
  - `validateHop(...)` returns `string[]`, all checked. Any blocked address still rejects the whole request.
  - In `run`, loop over the IPs. Each attempt gets its own pinned `Agent` with `connect: { lookup: pinnedLookup(ip), timeout: 3000 }`.
  - Move to the next IP only when the error (or its `cause`) has `code` in `ECONNREFUSED`, `EHOSTUNREACH`, `ENETUNREACH`, `EADDRNOTAVAIL`, `UND_ERR_CONNECT_TIMEOUT`, and only while the overall signal isn't aborted.
  - Otherwise rethrow at once. After the last IP, rethrow the last error.
- [ ] **Step 4: Run** the same command. Expected: all pass. Then run `pnpm test`. Expected: all pass.
- [ ] **Step 5: Commit** `feat(shared): safe-fetch falls back to the next checked address on connect failure`.

### Task 2: Shared scan contracts and link URL helpers

**Files:**
- Create: `packages/shared/src/contracts/scans.ts`, `packages/shared/src/links.ts`
- Modify: `packages/shared/src/contracts/index.ts`, `packages/shared/src/index.ts`
- Test: `packages/shared/src/contracts/scans.test.ts`, `packages/shared/src/links.test.ts`

**Interfaces:**
- Produces (from `@sg/shared`):
  - **Constants:**
    - `SCAN_LIMITS = { maxPages: 1000, maxLinks: 5000, batchMax: 500, timeBudgetMs: 1_200_000, startingTimeoutMs: 600_000 } as const`
    - `LINK_SCAN_QUEUE = "link-scan"`
    - `TRACKING_PARAMS: readonly string[]`
  - **zod schemas and types:**
    - `ScanType = z.enum(["link"])`
    - `ScanState = z.enum(["starting","queued","running","completed","failed","cancelled"])`
    - `TruncatedReason = z.enum(["page_cap","link_cap","time_limit"])`
    - `LinkStatus = z.enum(["ok","broken","redirect","restricted","warning","skipped"])`
    - `CreateScanRequest = { type: ScanType }`, strict.
    - `ScanPagesRequest = { pages: { url: string(max 2048), source: string(max 64) }[] (1..500), pages_found?: int 0..1_000_000 }`, strict.
    - `ScanStatus`: the fields in §7, with `counts` keys `ok, broken, redirect, restricted, warning, skipped, indexed, noindex, nofollow`.
    - `CreateScanResponse = ScanStatus.extend({ already_running: z.boolean() })`.
    - `ScanPagesResponse = { accepted, rejected, pages_submitted }`.
    - `LinkResult = { id: string, kind: "page"|"link", url, label: string|null, source, found_in: string|null, found_count, status: LinkStatus, http_code: number|null, detail: string|null, robots_index: "index"|"noindex"|null, robots_follow: "follow"|"nofollow"|null }`.
    - `ScanResultsResponse = { items: LinkResult[], next_cursor: string|null }`.
    - `LinkScanJob = { scan_id: uuid }`.
  - **Functions:**
    - `normalizeLinkUrl(href: string, base: string): { ok: true; url: string } | { ok: false; reason: "invalid" | "scheme" }`. Resolves `href` against `base`, lowercases the scheme and host, converts the host to punycode, drops default ports, the fragment and tracking params, and keeps other params in their original order. Non-http(s) schemes return `scheme`. An empty or bare `#` href returns `invalid`. Callers drop bare-`#` anchors (§8).
    - `isWpClutter(url: string, origin: string): boolean`. Applies only when the URL's origin equals `origin`. Matches §8's list: `replytocom` param; paths ending `/feed`, `/feed/` or `/comments/feed/`; `/wp-login.php`; prefix `/wp-admin/`; `/xmlrpc.php`; prefix `/wp-json/`; a `share` param.
    - `sameOrigin(url: string, origin: string): boolean`, using `normalizeOrigin`.

- [ ] **Step 1: Write failing tests.**
  - `links.test.ts`, `normalizeLinkUrl` cases (input, base → url):
    - `("../b", "https://ex.com/a/c/")` → `https://ex.com/a/b`
    - `("//cdn.ex.com/x", "https://ex.com/")` → `https://cdn.ex.com/x`
    - `("HTTP://Example.COM:80/p?utm_source=x&id=2#top", "https://ex.com/")` → `http://example.com/p?id=2`
    - `("https://bücher.de/", …)` → `https://xn--bcher-kva.de/`
    - `(" /a b ", "https://ex.com/")` → `https://ex.com/a%20b`
    - `("mailto:a@b.c", …)` → `{ok:false, reason:"scheme"}`
    - `("", …)` and `("http://[bad", …)` → `{ok:false, reason:"invalid"}`
    - `("/x?fbclid=1&gclid=2", "https://ex.com/")` → `https://ex.com/x`
  - `isWpClutter` true for `https://ex.com/?replytocom=5`, `/feed/`, `/comments/feed/`, `/wp-login.php?x`, `/wp-admin/`, `/wp-json/wp/v2`, `/?share=twitter`. False for `https://other.com/feed/` with origin `https://ex.com` and for `https://ex.com/feedback/`.
  - `scans.test.ts`:
    - `ScanPagesRequest` rejects 0 and 501 pages, extra keys, and `pages_found: -1`.
    - It accepts 500 pages.
    - `ScanStatus` parses a full example object.
- [ ] **Step 2: Run** `pnpm exec vitest run --project unit packages/shared`. Expected: FAIL (modules missing).
- [ ] **Step 3: Implement** the two files with the signatures above. Use WHATWG `URL` for resolution and punycode, and drop the port when it equals the scheme's default.
- [ ] **Step 4: Run** the same command, then `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(shared): scan contracts and link URL helpers`.

### Task 3: Migration 0002 — scan tables

**Files:**
- Create: `supabase/migrations/20261125000001_link_scans.sql`
- Test: `supabase/tests/link-scans.int.test.ts` (uses the existing `supabase/tests/globalSetup.ts`)

**Interfaces:**
- Produces:
  - `scan_jobs` gains the §6 columns: `pages_total`, `pages_checked`, `links_total`, `links_checked`, `pages_submitted` (int not null default 0); `pages_found` (int null); `truncated_reason` (text null, check in `('page_cap','link_cap','time_limit')`); `pgboss_job_id` (uuid null).
  - Unique index `uq_scan_jobs_active` on `(website_id, type) where status in ('starting','queued','running')`.
  - Tables `scan_pages(scan_job_id uuid fk cascade, url text, source text, ordinal int, unique(scan_job_id,url))`.
  - `link_results` with the columns in §6, these checks:
    - `kind in ('page','link')`
    - `status in (...)`
    - `char_length(label) <= 200`
    - `char_length(detail) <= 500`
    - robots enums
  - `link_results` constraints and indexes: `unique(scan_job_id, kind, url)` and index `(scan_job_id, id)`. `id` is `bigint generated always as identity` for cursor paging.
  - RLS enabled, anon and authenticated revoked, service_role granted. The same pattern as `20261124000001_foundation.sql`.

- [ ] **Step 1: Write failing integration tests:**
  - The new columns exist.
  - A second active link scan for the same website violates `uq_scan_jobs_active` (code `23505`). A second one after the first is `completed` is allowed.
  - Duplicate `(scan_job_id,'link',url)` violates the unique constraint.
  - A 201-character `label` violates its check.
  - The `anon` role can't select from `link_results` or `scan_pages`.
  - Deleting a `scan_jobs` row cascades to both tables.
- [ ] **Step 2: Run** `supabase db reset && pnpm exec vitest run --project integration supabase/tests/link-scans.int.test.ts`. Expected: FAIL.
- [ ] **Step 3: Write the migration.**
- [ ] **Step 4: Run** `supabase db reset && pnpm test:integration`. Expected: all pass, including Stage 1's.
- [ ] **Step 5: Commit** `feat(db): link scan tables and one-active-scan index`.

### Task 4: Core queue client and scan creation routes

**Files:**
- Create: `apps/core/src/lib/queue.ts`, `apps/core/src/routes/scans.ts`, `apps/core/src/lib/scan-store.ts`
- Modify: `apps/core/src/app.ts` (`AppDeps.queue`, mount `scansRouter`), `apps/core/src/server.ts` (create and start the queue), `apps/core/package.json` (add `pg-boss`)
- Test: `apps/core/src/routes/scans.int.test.ts`

**Interfaces:**
- Consumes: Task 2 contracts and `SCAN_LIMITS`, `LINK_SCAN_QUEUE`, `sameOrigin`, `normalizeLinkUrl`. Stage 1 `requireSite(deps)`, `siteOf(req)`, `limiter(pool,name,{points,durationSec},key)`, `audit(deps, entry)`, `ApiError`.
- Produces:
  - `interface JobQueue { enqueueLinkScan(scanId: string): Promise<string /* pg-boss job id */>; stop(): Promise<void> }`
  - `createPgBossQueue(databaseUrl: string): Promise<JobQueue>`. Calls `boss.start()` and creates the queue with `retryLimit: 2`, `retryDelay: 30`, `expireInSeconds: 1500`.
  - `AppDeps.queue: JobQueue` (required; tests pass a fake that records ids).
  - **`scan-store.ts`:**
    - `getStatus(pool, scanId, websiteId): Promise<ScanStatus|null>`. Computes `counts` from `link_results` with a GROUP BY, and `results_scan_id` per §7.
    - `latestScan(pool, websiteId, type)`.
    - `sweepStaleStarting(pool, websiteId, now)`.
    - `deleteFinishedNonCompleted(pool, websiteId, type)`.
  - **Routes** (all after `requireSite`): `POST /scans`, `POST /scans/:id/pages`, `POST /scans/:id/begin`.
  - **Limiters,** keyed by `siteOf(req).id`:
    - `scans-create` 10/h
    - `scans-pages` 30/h
    - `scans-read` 1,200/h (Task 5; raised from 600 in the final review)
    - `scans-cancel` 30/h (Task 5)

- [ ] **Step 1: Write failing integration tests** in `scans.int.test.ts`, building the app like `sites.int.test.ts` with a registered website and a fake queue:
  - `POST /scans {type:"link"}` → 201 with `status: "starting"` and `already_running: false`. The `scan.created` audit row exists.
  - A second `POST /scans` → 200 with the same `scan_id` and `already_running: true`.
  - A scan stuck in `starting` with `created_at` 11 min ago (`now` injected) is marked `failed` by the sweep, then a new scan is created (201).
  - Creating a scan deletes an earlier `cancelled` scan's rows but keeps the last `completed` one.
  - `/pages`:
    - 3 URLs on the origin + 1 `https://evil.com/x` + 1 `ftp://…` → `{accepted:3, rejected:2, pages_submitted:3}`.
    - A duplicate URL across two batches is stored once.
    - 1,001 distinct URLs over 3 batches → 1,000 stored and `truncated_reason: "page_cap"`.
    - `pages_found: 1340` is stored.
    - `/pages` after `begin` → 409 `conflict`.
  - `begin`:
    - With 0 pages, stores `origin + "/"` as the only page.
    - Sets `status: "queued"`, calls `queue.enqueueLinkScan(id)` once, and stores `pgboss_job_id`.
    - With `pages_found` (1,340) greater than the stored count (3), sets `truncated_reason: "page_cap"`.
  - Another site's `scan_id` on `/pages` and `/begin` → 404 `not_found`.
  - The 11th `POST /scans` in an hour → 429.
- [ ] **Step 2: Run** `pnpm exec vitest run --project integration apps/core/src/routes/scans.int.test.ts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `ApiError` gains `static conflict(message)` → 409 `conflict`. Add `"conflict"` to the shared error code enum if it's a closed set.
  - Create the scan inside one transaction: sweep, cleanup, then insert.
  - Catch `23505` on insert and return the existing active scan with `already_running: true`.
- [ ] **Step 4: Run** `pnpm test && pnpm test:integration`, then `pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): scan creation, page list upload and enqueue`.

### Task 5: Core scan read and cancel routes

**Files:**
- Modify: `apps/core/src/routes/scans.ts`, `apps/core/src/lib/scan-store.ts`
- Test: `apps/core/src/routes/scans.int.test.ts`

**Interfaces:**
- Produces:
  - `GET /scans/:id` → `ScanStatus`.
  - `GET /scans/latest?type=link` → `ScanStatus` or 404.
  - `GET /scans/:id/results?cursor&limit` → `ScanResultsResponse`. Default and max `limit` 500. `cursor` is the last `id` as a string. Ordered by `id` asc.
  - `POST /scans/:id/cancel` → `ScanStatus`. Only `starting`, `queued` or `running` can move to `cancelled`; any other status is returned unchanged. Writes the `scan.cancelled` audit.

- [ ] **Step 1: Write failing tests:**
  - **Results paging:** insert 1,201 `link_results` rows directly. Pages come back as 500/500/201, and the last `next_cursor` is null. `limit=9999` → 400.
  - **Counts:** `counts` match the rows. `indexed` counts page rows with `robots_index='index'`.
  - **`results_scan_id`:**
    - A completed scan → its own id.
    - A newer cancelled scan → the older completed scan's id.
    - A never-completed site → null.
  - **`latest`:** returns the newest scan of any status. A site with no scans → 404.
  - **Cancel:**
    - A running scan → `cancelled`, with the audit row.
    - A completed scan → unchanged 200.
    - Another site's id → 404.
  - **Reads:** the 601st read in an hour → 429 (with the limiter's `points` lowered through config injection, or by asserting the configured points if the limiter can't be tuned cheaply; pick one and note it).
- [ ] **Step 2: Run** `pnpm exec vitest run --project integration apps/core/src/routes/scans.int.test.ts`. Expected: the new tests FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test && pnpm test:integration`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(core): scan status, results paging and cancel`.

### Task 6: Worker page and link analysis (pure functions)

**Files:**
- Create: `apps/worker/src/link-scan/html.ts`, `apps/worker/src/link-scan/classify.ts`
- Modify: `apps/worker/package.json` (add `htmlparser2`, `@sg/shared`)
- Test: `apps/worker/src/link-scan/html.test.ts`, `apps/worker/src/link-scan/classify.test.ts`

**Interfaces:**
- Produces:
  - `extractPage(html: string, finalUrl: string, headers: Record<string,string>): { links: { url: string; label: string | null }[]; skipped: { href: string; reason: "scheme" | "invalid"; label: string | null }[]; robotsIndex: "index"|"noindex"; robotsFollow: "follow"|"nofollow" }`
    - Streaming `htmlparser2` `Parser`.
    - `<base href>` (first one) applies to everything after it.
    - `<a href>` text is trimmed, whitespace-collapsed and cut to 200 chars.
    - Robots come from `meta[name=robots|googlebot]` (case-insensitive, comma lists, `none` = noindex+nofollow) and the `x-robots-tag` header (bot-agnostic directives only).
    - Bare `#` anchors are dropped. `mailto:`/`tel:`/`javascript:`/`data:` go to `skipped`.
  - `classifyResponse(input: { requestedUrl: string; finalUrl: string; status: number }): { status: LinkStatus; httpCode: number; detail: string | null }`
  - `classifyError(err: SafeFetchError | Error): { status: LinkStatus; httpCode: null; detail: string }`
  - Both classifiers implement the §8 table. "Same URL" for `ok` means equal after normalizing, ignoring the http→https scheme change and a trailing slash difference.
  - Detail strings (exact):
    - `"Page not found (404)"`, `"Gone (410)"`, `"Client error (<code>)"`
    - `"Access restricted (<code>)"`, `"Server error (<code>)"`, `"Rate limited (429)"`
    - `"Redirects to <finalUrl>"`
    - `"Timed out"`, `"Couldn't find this website (DNS)"`, `"Connection refused"`, `"Secure connection failed"`, `"Too many redirects"`
    - `"Not checked: points to a private network address"`, `"Not checked: port not allowed"`, `"Invalid link"`
    - `"Page too large to read fully"`
  - Map `SafeFetchError.code` → bucket:
    - `dns_failed` → broken
    - `network_error` → broken "Connection refused" when the cause code is `ECONNREFUSED`, otherwise warning "Secure connection failed" for TLS codes (`ERR_TLS_*`, `CERT_*`, `DEPTH_ZERO_*`, `UNABLE_TO_*`), else warning "Connection failed"
    - `timeout` → warning
    - `too_many_redirects` → warning
    - `blocked_address`, `bad_port` → skipped
    - `invalid_url`, `bad_scheme` → skipped "Invalid link"

- [ ] **Step 1: Write failing tests.**
  - `html.test.ts`:
    - A page with nav, footer and content links, `<base href="https://ex.com/sub/">`, `href="x"` → `https://ex.com/sub/x`.
    - Duplicates within one page are both returned (dedupe happens later).
    - `<a href="mailto:a@b">Mail</a>` → `skipped[0].reason === "scheme"`.
    - `<a href="#top">` → absent everywhere.
    - `<meta name="ROBOTS" content="NoIndex, follow">` → `noindex/follow`.
    - `x-robots-tag: none` → `noindex/nofollow`.
    - `x-robots-tag: otherbot: noindex` → `index/follow`.
    - Malformed HTML (unclosed tags) doesn't throw.
  - `classify.test.ts`: one test per row of the §8 table, plus:
    - `https://ex.com/a` → final `https://ex.com/a/` at 200 → `ok`.
    - `http://` → `https://` same path → `ok`.
    - → `https://ex.com/b` → `redirect` with detail `"Redirects to https://ex.com/b"`.
    - Each `SafeFetchError` code above maps to its bucket.
- [ ] **Step 2: Run** `pnpm exec vitest run --project unit apps/worker`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(worker): HTML link and robots extraction, response classification`.

### Task 7: Worker scan engine

**Files:**
- Create: `apps/worker/src/link-scan/engine.ts`, `apps/worker/src/link-scan/limits.ts`
- Test: `apps/worker/src/link-scan/engine.test.ts`

**Interfaces:**
- Consumes: Task 6, plus `safeFetch` and `SCAN_LIMITS` from `@sg/shared`.
- Produces:
  - `interface ScanSink { alreadyChecked(): Promise<{ pages: Set<string>; links: Set<string> }>; writeResults(rows: ResultRow[]): Promise<void>; progress(p: { pagesTotal: number; pagesChecked: number; linksTotal: number; linksChecked: number }): Promise<"continue" | "cancelled">; }`
    - `ResultRow` = the `link_results` columns without `id` and `checked_at`.
  - `runLinkScan(input: { origin: string; pages: { url: string; source: string }[]; allowLocal: boolean; userAgent: string; fetcher: typeof safeFetch; sink: ScanSink; now: () => number; deadlineAt: number }): Promise<{ outcome: "completed" | "cancelled"; truncated: "link_cap" | "time_limit" | null }>`
  - `createKeyedLimiter(perKey: number, total: number): <T>(key: string, fn: () => Promise<T>) => Promise<T>` in `limits.ts`. The origin uses a separate limiter with per-key 4.
- Behaviour, from §8:
  - **Phase 1 (pages, in order):**
    - Fetch each page with GET and `maxBytes: 2_097_152`, `timeoutMs: 15_000`, `allowPrivate: allowLocal`, and `allowedPorts` = `[80, 443]` plus the origin port when `allowLocal`.
    - Write a page row with the classification and robots. Robots are null unless the 2xx response is `text/html`.
    - Extract links only when the response is 2xx `text/html`, `finalUrl` is on `origin`, and it isn't truncated. A truncated page row → `warning` "Page too large to read fully".
  - **Link dedupe** is in-memory across the scan:
    - First `found_in` and label win, and `found_count` increments.
    - `isWpClutter` links are dropped.
    - Stop adding at 5,000 → `truncated: "link_cap"`.
    - Skipped hrefs become `skipped` link rows, deduped too.
  - **Phase 2 (links):**
    - A link equal to a fetched page URL reuses that page's classification, with no fetch.
    - Same-site links: GET with `maxBytes: 65_536` and `timeoutMs: 10_000`, under the origin limiter.
    - External links: HEAD with `timeoutMs: 10_000`; on 405, 501 or a `network_error`/`timeout`, GET with `maxBytes: 65_536`. Run under the keyed limiter by host, `(2, 16)`.
  - **Writes and progress:** rows are written in batches of up to 100, and `sink.progress` is called at most once a second and after each phase. `"cancelled"` → stop scheduling, wait for in-flight requests, return `cancelled`.
  - **Time budget:** when `now() >= deadlineAt`, stop scheduling and return `completed` with `truncated: "time_limit"`.
  - **Resume:** URLs in `alreadyChecked()` aren't fetched or written again. Their pages are still re-fetched for link extraction if the scan was mid phase 1, because extracted links aren't persisted (accepted cost).
  - Every request sends only `User-Agent` and `Accept`.

- [ ] **Step 1: Write failing tests** with a fake `fetcher` (a map from URL to response or error, recording calls) and an in-memory sink:
  - Two pages sharing a footer link to `https://ext.com/a` (404) → one link row, `found_count: 2`, `broken`, `"Page not found (404)"`, and `ext.com/a` fetched once (HEAD).
  - **Review Focus 1:** a page whose `finalUrl` is `https://other.com/landing` → page row `redirect`, and none of its links are fetched.
  - **Review Focus 2:** a page with `content-type: application/pdf` → page row `ok` with null robots and no links. A truncated HTML page → `warning` "Page too large to read fully" with no links.
  - **Review Focus 5:** one external host's links all reject after the fake's 10 s timeout (use fake timers or `now`). Links on another host complete first, the hung ones are `warning` "Timed out", and the result is `completed`.
  - A page link `https://ex.com/about/` that's also in `pages` → no second fetch, and the link row copies the page status.
  - A HEAD that gets 405 then a GET that gets 200 → `ok`.
  - `https://ex.com/?replytocom=3` → no row.
  - The 5,001st unique link → `truncated: "link_cap"` and 5,000 link rows (generated pages).
  - The sink returns `"cancelled"` after the first progress → outcome `cancelled`, and no fetches start afterwards.
  - `deadlineAt` already passed after page 1 → `completed`, `time_limit`.
  - **Spec Done-when 7:** with the real `safeFetch` as `fetcher` and `allowLocal: false`, page links to `http://169.254.169.254/latest` and `http://127.0.0.1:8080/x` → both `skipped` "Not checked: points to a private network address". Both are IP literals, so safe-fetch refuses them before any connect and no network is used.
  - `alreadyChecked` holds 2 link URLs → they aren't fetched.
  - **Concurrency:** the fake records the in-flight count per host. The max for the origin is ≤ 4 and per external host ≤ 2.
- [ ] **Step 2: Run** `pnpm exec vitest run --project unit apps/worker`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(worker): link scan engine with per-host limits, resume and budgets`.

### Task 8: Worker job runtime (pg-boss + Postgres sink)

**Files:**
- Create: `apps/worker/src/link-scan/pg-sink.ts`, `apps/worker/src/link-scan/job.ts`
- Modify: `apps/worker/src/worker.ts` (replace the idle shell), `apps/worker/src/main.ts` (env: `DATABASE_URL` required, `ALLOW_LOCAL_SITES` (refused with `NODE_ENV=production`), `LOG_LEVEL`, `NODE_ENV`), `apps/worker/src/worker.test.ts`, `apps/worker/package.json` (`pg`, `pg-boss`), `apps/worker/Dockerfile` if env docs live there
- Test: `apps/worker/src/link-scan/job.int.test.ts`

**Interfaces:**
- Consumes: Task 7's `runLinkScan` and `ScanSink`; Task 3's tables; `LINK_SCAN_QUEUE` and `LinkScanJob`.
- Produces:
  - `createPgSink(pool, scanId): ScanSink`.
    - `writeResults` uses `insert … on conflict (scan_job_id, kind, url) do nothing`.
    - `progress` updates the counters plus `total` and `processed`, and returns `"cancelled"` when the row's status is `cancelled`.
  - `handleLinkScanJob(deps: { pool; fetcher; allowLocal; now; log }, job: { id: string; data: unknown; retryCount: number; retryLimit: number }): Promise<void>`
    - Loads the scan.
    - If it isn't `queued` or `running`, returns (cancelled before start).
    - Sets `running` and `started_at` (once) and `attempt_count += 1`.
    - `deadlineAt` = `started_at` + 20 min.
    - Runs the engine.
    - **On `completed`:** in one transaction, sets `completed`, `completed_at` and `truncated_reason` (keeping an existing `page_cap` unless a new reason is set), deletes the site's other link scans, and writes the `scan.completed` audit row (direct insert into `audit_logs`, `actor = 'system'`).
    - **On `cancelled`:** leaves the status.
    - **On a throw:** rethrows so pg-boss retries. When `retryCount >= retryLimit`, sets `failed` with error `"The scan stopped unexpectedly. Please try again."` and writes the `scan.failed` audit row first.
  - `startWorker(config: { databaseUrl: string; allowLocal: boolean; logLevel?: string }): Promise<WorkerHandle>`. Starts pg-boss and `boss.work(LINK_SCAN_QUEUE, { batchSize: 1 }, …)`. `stop()` stops pg-boss gracefully.

- [ ] **Step 1: Write failing integration tests** (real local Supabase, a fake fetcher in place of safe-fetch):
  - Seed a website, a scan in `queued` and 2 `scan_pages`. Call `handleLinkScanJob` → `completed`, rows written, `pages_checked = 2`, and the audit row exists.
  - An older completed scan for the same site is deleted after completion.
  - **Review Focus 4:**
    - The fake fetcher throws a plain `Error` after 3 link fetches on the first call, so the handler rethrows. The scan stays `running`.
    - A second call (`retryCount: 1`) completes with no duplicate rows (count equals unique URLs), and the counters equal the row counts.
  - A third failure with `retryCount: 2, retryLimit: 2` → `failed` with the friendly error and the `scan.failed` audit row.
  - A scan set to `cancelled` before the handler runs → returns, nothing written.
  - `worker.test.ts`: `startWorker` with a fake boss factory registers `LINK_SCAN_QUEUE` and `stop()` stops it. Inject the factory as an optional second parameter.
- [ ] **Step 2: Run** `pnpm exec vitest run --project integration apps/worker`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test && pnpm test:integration && pnpm typecheck`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(worker): pg-boss link scan jobs with Postgres sink, retry and retention`.

### Task 9: Plugin page list and scan REST proxy

**Files:**
- Create: `plugin/src/Scan/PageList.php`, `plugin/src/Rest/ScanController.php`
- Modify: `plugin/src/Plugin.php` (register `ScanController`), `plugin/uninstall.php` (nothing new to delete; confirm and leave unchanged)
- Test: `plugin/tests/Unit/PageListTest.php`, `plugin/tests/Unit/ScanControllerTest.php`

**Interfaces:**
- Consumes: `Core\Client::request(method, path, body, auth)` → `Result`; `ChatController::can_chat()` as the permission callback; Stage 1 error mapping (`ChatController::error_for` or its equivalent; extract a shared `Rest\CoreErrors::response(Result)` if it's private).
- Produces:
  - `PageList::collect(): array{pages: list<array{url:string,source:string}>, found:int}`
    - The home page `home_url('/')` comes first with source `home`.
    - Then `WP_Query` with `post_status=publish`, post types = `get_post_types(['public'=>true])` minus `PageList::EXCLUDED` (the §7 list, filtered by `site_guardian_scan_excluded_post_types`), `orderby=modified`, `order=DESC`, `fields=ids`, `posts_per_page=1000`, `no_found_rows=false`.
    - `found` = `found_posts + 1`.
    - URLs come from `get_permalink`, de-duplicated against the home page.
  - **`ScanController` routes** (`site-guardian/v1`, permission `ChatController::can_chat`):
    - `POST scans/link`: create → batches of 500 to `/pages` (with `pages_found` on the last) → `begin`. If create returns `already_running`, skips `/pages` and `begin` and returns the status. Returns 200 with `ScanStatus`.
    - `GET scans/link/current` → Core `GET /scans/latest?type=link`. A 404 becomes `200 {"status":"none"}`. `"none"` is a plugin-only value the JS handles; it isn't part of `ScanState`.
    - `GET scans/link/results?cursor=` → reads `results_scan_id` from `latest`. Null → `200 {items:[],next_cursor:null}`. `cursor` is validated as `^\d{1,19}$`.
    - `POST scans/link/cancel` → reads `latest`. Active → `POST /scans/:id/cancel`, otherwise returns the latest status.
    - Test seam: `ScanController::set_sender(?callable)`, like `ChatController`.

- [ ] **Step 1: Write failing PHPUnit tests.**
  - `PageListTest` (Brain Monkey stubs for `get_post_types`, `apply_filters`, `WP_Query` via a test double class, `get_permalink`, `home_url`):
    - Excluded types aren't queried.
    - The filter can add a type.
    - Home comes first.
    - A permalink equal to home isn't repeated.
    - `found` counts home.
  - `ScanControllerTest`:
    - 1,001 pages → `/pages` is called 3 times (500, 500, 1), and only the last carries `pages_found`.
    - `already_running` → no `/pages` call.
    - A network error → 502 with code `network_error` and `Client::NETWORK_MESSAGE`. Core error bodies pass through with their status and `request_id`, as chat does, but without chat's `ai_unavailable` wording.
    - `current` with Core 404 → `{"status":"none"}`.
    - `results` uses `results_scan_id`, never a browser-supplied id (the request has `scan_id=evil` and it's ignored).
    - A bad cursor `1;drop` → 400.
    - Cancel on a completed scan makes no cancel call.
    - Every route's `permission_callback` is `can_chat`.
- [ ] **Step 2: Run** `cd plugin && vendor/bin/phpunit --filter 'PageListTest|ScanControllerTest'`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `cd plugin && vendor/bin/phpunit && vendor/bin/phpcs`. Expected: PASS and clean.
- [ ] **Step 5: Commit** `feat(plugin): published page list and link scan REST proxy`.

### Task 10: Link Scanner screen

**Files:**
- Create: `plugin/assets/js/screens/link-scanner.js`, `plugin/assets/js/csv.js`
- Modify:
  - `plugin/assets/js/api.js`: `startLinkScan()`, `getCurrentLinkScan()`, `getLinkResults(cursor?)`, `cancelLinkScan()`.
  - `plugin/assets/js/app.js`: mount the link scanner on `#sg-panel-links`.
  - `plugin/templates/app.php`: remove `data-coming-soon` and the "Coming soon" `<p>` from the links panel only. Add a Cancel button `#sga-scan-cancel` (hidden), a `#sga-scan-notice` `role="status"` element and a `#sga-last-scanned` element. Keep all existing ids.
  - `plugin/assets/css/link-scanner.css`: styles for the new elements only.
- Test: `plugin/assets/js/__tests__/link-scanner.test.js`, `plugin/assets/js/__tests__/csv.test.js`, `plugin/assets/js/__tests__/api.test.js`

**Interfaces:**
- Consumes: Task 9's routes and the `ScanStatus` / `LinkResult` shapes (Task 2).
- Produces:
  - `mountLinkScanner(root: Element, deps: { api, setTimeout?, document? }): { destroy(): void }`
  - `toCsv(rows: LinkResult[]): string`. Columns `URL, Source, Found In, Index, Follow, Status, HTTP Code, Detail`; UTF-8 BOM; CRLF; quoted; formula cells prefixed `'`.
- Behaviour (§10):
  - **On mount:** call `getCurrentLinkScan`.
    - Active → progress plus polling.
    - `completed` → load results and show "Last scanned <relative time>" with Re-scan.
    - `none` → show the start button.
    - `failed` → show its `error`, Try again, and the `results_scan_id` results if any.
    - `cancelled` → show "Scan cancelled", plus the previous results.
  - **Polling:** every 2,000 ms, then 5,000 ms after 2 minutes, paused while `document.hidden`, resumed on `visibilitychange`.
  - **Progress label:** `"Checking pages… {pages_checked} / {pages_total}"` while `pages_checked < pages_total`, else `"Checking links… {links_checked} / {links_total}"`. The bar width is set through a CSS custom property or class steps, CSP-safe (CSSOM `style.setProperty` is allowed per R21).
  - **Results:** loaded with `getLinkResults` until `next_cursor` is null. Rows are built with DOM APIs and `textContent` only. `href` is set only when `new URL(u).protocol` is `http:` or `https:`.
  - **Pills, filters and search:** ported from the old `link-scanner.js`. Pills come from `counts`.
  - **Notices:**
    - `page_cap`: `"Checked the {pages_total} most recently updated pages of {pages_found}. Very large sites are partly scanned for now."`
    - `link_cap`: `"Checked the first 5,000 links. Very large sites are partly scanned for now."`
    - `time_limit`: `"The scan reached its time limit. Results show what was checked."`
  - **Errors:** session expired → the chat's message.
    - `not_connected` → `"Connect your site to Site Guardian in Settings first."`
    - `rate_limited` → `"You've started several scans recently. Please wait a bit and try again."`
  - **Export:** a Blob download named `site-guardian-links.csv`.

- [ ] **Step 1: Write failing jsdom tests** with a fake `api` and fake timers:
  - Mount with `current` → `running` 10/40 pages → the label is `"Checking pages… 10 / 40"`. After a 2 s tick, `current` is called again. A hidden document → no call.
  - `current` → `completed` → results are fetched until `next_cursor` is null (2 pages), and the row count equals the items.
  - A result with `url: "javascript:alert(1)"` and `label: "<img src=x onerror=alert(1)>"` → no `href` attribute, the label is shown as text, and `querySelector("img")` is null.
  - `page_cap` with `pages_total 1000` and `pages_found 1340` → the notice text is exact.
  - Cancel click → `cancelLinkScan` is called and the UI shows "Scan cancelled".
  - `startLinkScan` rejecting with `rate_limited` → the exact message.
  - `csv.test.js`: header row, BOM, `=SUM(A1)` → `'=SUM(A1)`, quotes doubled.
  - `api.test.js`: each new method hits the right path and method.
  - `static.test.js` (existing) still passes: no inline `style=` or scripts in the template.
- [ ] **Step 2: Run** `pnpm exec vitest run --project plugin`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** `pnpm test` and `cd plugin && vendor/bin/phpcs`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(plugin): live Link Scanner screen with polling, results and CSV`.

### Task 11: Local environment, end-to-end checks and docs

**Files:**
- Modify:
  - `e2e/core.ts`: generalize to start and stop both Core and the worker. Worker env: `DATABASE_URL`, `ALLOW_LOCAL_SITES=true`, `LOG_LEVEL=warn`.
  - `e2e/global-setup.ts`: build `@sg/worker` too; delete `link-scan` rows for the local site.
  - `scripts/dev-setup.sh`: create the fixture content, idempotently, using posts identified by slug:
    - post `sg-fixture-links` with links to `/sg-missing-page/` (404), `https://example.com/` (external OK), `mailto:hi@example.com`, and `/?replytocom=1`
    - page `sg-fixture-noindex`, with noindex set through the `wp_robots` filter in a tiny mu-plugin `scripts/mu-plugins/sg-fixture-noindex.php`, mounted by docker compose into `wp-content/mu-plugins`
  - `docker-compose.yml`: mount the mu-plugins directory.
  - `README.md`: "Run the worker" step (`node --env-file=apps/core/.env apps/worker/dist/main.js`) and the e2e notes.
- Create: `e2e/stage2.spec.ts`

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Write `stage2.spec.ts`** (serial, admin logged in via the Stage 1 `logIn` helper, moved to `e2e/helpers.ts`):
  1. Open `/site-health-check/`, open the Link Scanner tab, and click **Scan All Links**. Progress appears, then results.
     - The row for `/sg-missing-page/` is Broken.
     - The `mailto:` row is Skipped.
     - There's no `replytocom` row.
     - The `sg-fixture-noindex` page row shows Noindex.
     - The `https://example.com/` row is OK.
  2. Reload mid-scan: start a scan, reload at once, and see the progress again, then results (spec Done-when 2).
  3. Stop the worker mid-scan, restart it, and the scan completes with no duplicate URLs in the table (Done-when 3).
  4. Click Scan twice quickly → one scan (Done-when 4; check through `GET scans/link/current`, which returns the same id).
  5. Start then Cancel → "Scan cancelled" (Done-when 5).
  6. Export CSV → the download's first line is the header in §10 (Done-when 8).
  7. No console errors on the page (CSP), as in Stage 1's check.
- [ ] **Step 2: Run** `docker compose up -d && scripts/dev-setup.sh && pnpm --filter e2e test`. Expected: FAIL before the fixtures and wiring are done, then PASS.
- [ ] **Step 3:** Fix whatever the run exposes. Each product fix gets a unit test in the owning package.
- [ ] **Step 4: Run the full gate:** `pnpm typecheck && pnpm lint && pnpm test && pnpm test:integration && (cd plugin && vendor/bin/phpunit && vendor/bin/phpcs) && pnpm --filter e2e test`. Expected: all pass, Stage 1's e2e included.
- [ ] **Step 5: Commit** `test: Stage 2 end-to-end link scan checks, fixtures and docs`.
