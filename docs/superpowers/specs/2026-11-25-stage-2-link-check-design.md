# Site Guardian — Stage 2: Link Check (design)

Date: 2026-11-25
Status: approved 2026-11-25
Builds on: `2026-11-24-site-guardian-rebuild-design.md` (the "rebuild spec"). Its architecture,
security model and global constraints still apply. This document only adds to them.

## 1. Intent

Bring the Link Scanner tab to life. A site owner clicks **Scan All Links**, watches progress, and
gets a table of every published page and every link on those pages. Each row is marked OK,
broken, redirect, restricted, warning or skipped, and pages also show indexed, noindex or nofollow.
The owner can filter, search and export the table to CSV.

The screen already exists from the Stage 1 UI port (`plugin/templates/app.php`, panel
`#sg-panel-links`) and shows "coming soon". The old plugin's behaviour
(`../site-guardian-ai/assets/js/link-scanner.js`, `includes/class-sga-link-collector.php`,
`class-sga-checker.php`) is the reference for what the owner sees. The old code is not a reference
for how it works: there, the browser and WordPress did the checking, and now Core's worker does.

Stage 2 also builds the job system that Stages 4 and 5 (the layout check and performance) reuse.

## 2. Goals, non-goals, anti-goals

**Goals**
- The results an owner got from the old scanner, now including links in menus, headers, footers
  and sidebars (§3.6): every published page plus the links on it,
  with status buckets, HTTP code, detail, robots (indexed, noindex, nofollow), filters, search,
  and CSV export.
- Scans run as background jobs. They survive closed tabs, page reloads and worker restarts.
  Reopening the tab shows the running scan, or the latest results.
- A job system (pg-boss + `scan_jobs`) generic enough for the browser and performance jobs later.

**Non-goals (Stage 2)**
- The AI using scan results. `start_link_check` and `get_scan_results` tools arrive in Stage 3.
  The chat's quick action "Check all the links…" stays a plain chat message.
- Credits and billing for scans (Stage 6). Stage 2 bounds cost with fixed caps (§5).
- Scheduled or recurring scans, email reports, and scan history beyond the latest scan.
- WordPress installed in a sub-folder (see §3). Multisite networks.
- Layout, performance and remote scan screens (they stay "coming soon").

**Anti-goals**
- The browser choosing what gets fetched. The browser can start, poll and cancel scans. The page
  list comes from the plugin's PHP, server-side, and Core re-checks every URL.
- Treating the plugin's page list as results. Every status, link and robots value comes from what
  the worker itself fetched.
- The scanner hammering the owner's site or third-party sites, or reaching private networks.
- Any scan-derived text (URLs, link labels, error details) rendered as HTML.

## 3. Decisions made with the user (2026-11-25)

1. **What a scan covers: every published page the owner has** (option a). The plugin sends Core
   the URLs of its published posts, pages and public post types. This list only says where to
   look. Core fetches every page itself. Option (b), crawling from the home page and the sitemap,
   was rejected because it misses pages nothing links to, and owners expect "all my pages".
2. **Limits** (proposed by Claude, accepted by the user):
   - **Per scan:** at most 1,000 pages and 5,000 unique links. On a bigger site the scan checks the
     first 1,000 pages and the results say so ("Checked 1,000 of 1,340 pages").
   - **Page-list upload:** the plugin sends the list in batches of up to 500.
   - **One scan at a time per site:** starting while one runs returns the running scan.
   - **Concurrency:** at most 4 requests at a time to the owner's site and 2 per external host.
   - **Retention:** only the latest completed scan's results are kept per site.
3. **Sub-folder installs:** still not supported in Stage 2. The Stage 1 rejection at
   `register/start` stays. Supporting them needs a path-aware site identity, which is separate work.
4. **Address fallback in safe-fetch:** when a checked address refuses the connection or is
   unreachable, safe-fetch tries the host's next checked address. It never falls back to an
   unchecked one. Details are in §9.
5. **Build approach A** (§4).
6. **Which links are checked: every `<a href>` on the page as visitors see it**, including menus,
   headers, footers and sidebars. This differs from the old scanner, which read only `post_content`.
   It was chosen because a broken menu link is the one every visitor hits. Each link is checked
   once per scan, so a footer link shared by hundreds of pages is one row (with `found_count`).
   WordPress clutter links are skipped and tracking parameters are merged (§8).

## 4. Approaches considered

| | Approach | Trade-off | Outcome |
|---|---|---|---|
| A | One pg-boss job per scan. One worker runs the whole scan, writes results as it goes, and resumes from them after a restart | Simple. Per-host politeness lives in one process. Adding workers adds parallel scans, not speed for one scan | **Chosen.** A capped scan takes minutes |
| B | Split a scan into many batch jobs (pages or links) that any worker can take, plus a final aggregation step | One big scan finishes faster, but it needs completion tracking, partial retries, and per-host limits coordinated across processes | Rejected: only pays off far above the caps |
| — | Core checks the links during the request while the plugin waits | Holds requests open for minutes and breaks "survives tab closes and restarts" | Rejected |
| — | A homemade Postgres queue instead of pg-boss | Contradicts the rebuild spec for no gain | Rejected |

## 5. Flow

```
Owner clicks "Scan All Links"
  browser ──POST site-guardian/v1/scans/link──► plugin (PHP)
     plugin builds the page list from WP (published, public post types)
     plugin ──POST /scans {type:"link"}────────────────► Core: creates scan_jobs row, status "starting"
     plugin ──POST /scans/:id/pages (≤500 per call)×N──► Core: validates and stores the page list
     plugin ──POST /scans/:id/begin───────────────────► Core: status "queued", enqueue pg-boss job
  browser polls site-guardian/v1/scans/link/current every 2 s
     plugin ──GET /scans/:id──────────────────────────► Core: status, counts, progress
Worker claims job ─► status "running"
  phase 1: fetch each page (≤4 at a time), record page status + robots, extract links
  phase 2: check each unique link (own site ≤4 at a time, ≤2 per external host)
  results written to link_results as it goes; scan_jobs.processed/total updated
  ─► status "completed" (or "failed" / "cancelled")
Browser loads results ── plugin ──GET /scans/:id/results?cursor=… (pages of 500)
```

- **Starting while a scan is active** (`starting`, `queued` or `running`) returns that scan
  instead (HTTP 200, `already_running: true`). A `starting` scan with no `begin` after 10 minutes
  is marked `failed` by a sweep, so it can't block the site forever.
- **Cancel:** the browser can cancel. Core sets `cancelled`, and the worker checks for that
  between requests and stops.
- **Resume:** pg-boss retries a job whose worker died, up to 2 more times. The worker skips URLs
  already in `link_results` for that scan.
- **Time budget:** a scan running longer than 20 minutes stops with status `completed` and a
  `truncated_reason` of `time_limit`, keeping what it has.

## 6. Data model (migration 0002)

Uses the existing `scan_jobs` table (rebuild spec, migration 0001). Changes:

- `scan_jobs` gains:
  - `pages_total` and `pages_checked` (int, default 0); `links_total` and `links_checked`
    (int, default 0).
  - `truncated_reason` (text, null), one of `page_cap`, `link_cap`, `time_limit`.
  - `pages_submitted` (int, default 0): how many valid page URLs Core received.
  - `pages_found` (int, null): the plugin's count of published pages (a hint, §7).
  - `pgboss_job_id` (uuid, null).
  - The existing `total` and `processed` columns stay as overall progress
    (`pages_total + links_total` and `pages_checked + links_checked`).
- **Partial unique index:** at most one active scan per site and type:
  `unique (website_id, type) where status in ('starting','queued','running')`.
- New table `scan_pages`: `scan_job_id` (fk, cascade), `url` (text), `source` (text: the
  post type label from the plugin), `ordinal` (int). Unique on `(scan_job_id, url)`. This is the
  page list, never results.
- New table `link_results`:
  - `id`, `scan_job_id` (fk, cascade), `kind` (`page` | `link`), `url` (text, normalized), `label`
    (text, the link text, capped at 200 chars).
  - `source` (text: the post type for pages, `page` for links), `found_in` (text: the first page
    the link was seen on), `found_count` (int).
  - `status` (`ok` | `broken` | `redirect` | `restricted` | `warning` | `skipped`),
    `http_code` (int, null), `detail` (text, capped at 500 chars).
  - `robots_index` (`index` | `noindex` | null) and `robots_follow` (`follow` | `nofollow` | null);
    pages only.
  - `checked_at`.
  - Unique on `(scan_job_id, kind, url)`, with an index on `(scan_job_id, id)` for cursor paging.
- **Retention:**
  - When a link scan completes, earlier link scans of that site (any status) and their rows are
    deleted in the same transaction.
  - When a new link scan is created, earlier `cancelled` or `failed` link scans of that site are
    deleted. The last `completed` one is kept until the new scan completes.
  - So a site holds at most: the last completed scan, plus one newer scan that is active,
    cancelled or failed.
- RLS on for the new tables, no anon or authenticated grants, service_role explicit, the same as
  migration 0001.
- pg-boss creates its own schema (`pgboss`) at worker and Core start, through `DATABASE_URL`.

## 7. API

**Contracts** are zod schemas in `packages/shared/src/contracts/scans.ts`, used by Core, the
worker and the tests.

### Core (all require the site credential, `requireSite`, under `/api/v1`)

| Route | Body / query | Response |
|---|---|---|
| `POST /scans` | `{ type: "link" }` | `201 { scan_id, status: "starting" }`, or `200 { scan_id, status, already_running: true }` |
| `POST /scans/:id/pages` | `{ pages: [{ url, source }], pages_found? }`, 1–500 items | `200 { accepted, rejected, pages_submitted }` |
| `POST /scans/:id/begin` | `{}` | `200 { scan_id, status: "queued" }` |
| `GET /scans/:id` | — | `200 ScanStatus` (below) |
| `GET /scans/latest?type=link` | — | `200 ScanStatus`, or `404 not_found` if the site has never scanned |
| `GET /scans/:id/results` | `?cursor=<id>&limit≤500` | `200 { items: LinkResult[], next_cursor \| null }` |
| `POST /scans/:id/cancel` | `{}` | `200 ScanStatus` |

- `ScanStatus` = `{ scan_id, type, status, pages_total, pages_checked, links_total, links_checked,
  pages_submitted, pages_found, truncated_reason, results_scan_id, counts: { ok, broken, redirect, restricted, warning, skipped,
  indexed, noindex, nofollow }, created_at, started_at, completed_at, error }`. `error` is a
  friendly message, never internal detail.
- **`latest` and `results_scan_id`:**
  - `GET /scans/latest` returns the site's newest scan of that type, whatever its status.
  - `results_scan_id` names the scan whose results the owner should see: this scan if it
    completed, otherwise the site's last completed scan (or null if there is none).
  - So after a cancelled or failed scan, the owner sees that status and the previous good results.
- **Ownership:** every `:id` route checks `scan_jobs.website_id = req.website.id`. Another site's
  id returns `404 not_found`, never 403, so ids can't be probed.
- **`/pages` rules:**
  - Allowed only while the scan is `starting`.
  - Each URL is parsed and its normalized origin must equal the site's origin. Anything else
    counts as rejected, including any other host, a non-http(s) scheme, or credentials in the URL.
  - Accepted URLs are normalized (§8), de-duplicated, and stored until the scan holds 1,000 pages.
    Past that they are counted in `pages_submitted` but not stored, and `truncated_reason` becomes
    `page_cap`.
  - `pages_found` (optional, integer 0–1,000,000) is stored as given on the last call that sends
    it. It is a display hint only: it never changes which pages are fetched. At `begin`, if
    `pages_found` is greater than the number of stored pages, `truncated_reason` becomes `page_cap`,
    which drives the "Checked X of Y" notice.
- **`begin`** with zero stored pages stores the site root (`origin + "/"`) as the only page, so a
  scan always has something to check.
- **Rate limits** (Postgres limiter, per site):
  - `POST /scans`: 10 per hour.
  - `/pages`: 30 per hour, enough for 2 full scans' batches.
  - Reads: 600 per hour.
  - `cancel`: 30 per hour.
- **Audit:** `scan.created`, `scan.cancelled`, `scan.completed` and `scan.failed` rows in
  `audit_logs`.

### Plugin (WP REST `site-guardian/v1`, same permission as chat: logged in + Site Guardian capability)

| Route | What it does |
|---|---|
| `POST scans/link` | Builds the page list server-side, then calls Core `POST /scans` → `/pages` ×N → `/begin`. Returns `ScanStatus`. The browser sends no URLs. |
| `GET scans/link/current` | Proxies `GET /scans/latest?type=link` |
| `GET scans/link/results` | Proxies `GET /scans/:id/results` with `cursor`. The id is `results_scan_id` from Core's `latest`, not from the browser. |
| `POST scans/link/cancel` | Cancels the latest scan if it is active |

- **The page list** is built with `WP_Query`:
  - `post_status = publish`, all `public` post types except `attachment` and the old plugin's
    builder and template types: `elementor_library`, `elementor-hf`, `popup_theme`, `popups`,
    `pum-popup`, `oembed_cache`, `wp_block`, `wp_template`, `wp_template_part`,
    `wp_global_styles`, `wp_navigation`. A filter `site_guardian_scan_excluded_post_types` lets
    site owners extend the list.
  - `fields = ids`, using the permalink of each.
  - Ordered by modified date (newest first), so the cap keeps the most recently edited pages.
  - The home page (`home_url('/')`) goes first.
  - The plugin stops collecting at 1,000 URLs and sends the true total as a separate
    `pages_found` hint (§7, Core rules). That hint is shown only in the "Checked X of Y" notice
    and is never trusted for anything else.
- **Timeouts:** Core calls use `Client::request` with the default 15 s. Start does several quick
  calls, so it needs no longer route timeout.
- **Errors** map the same way chat does: `not_connected` → 503, network → 502 with a friendly
  message, and Core error bodies pass through with `request_id`.

## 8. Worker: how a link scan runs

**Phase 1: pages.** For each stored page, in `ordinal` order, at most 4 at a time:
- GET the page through safe-fetch with:
  - a 15 s timeout and at most 2 MB of body
  - up to 5 redirects
  - `allowedPorts` and `allowPrivate` matching how the site registered (`ALLOW_LOCAL_SITES` only
    in development)
- Record a `kind = page` row with status, code, detail and robots.
- **Robots values:** `noindex` / `nofollow` come from `<meta name="robots">` (and
  `name="googlebot"`) plus the `X-Robots-Tag` header. If neither is present the page is
  `index` / `follow`. Pages that didn't return HTML get null robots.
- **Extracting links:** only from 2xx `text/html` pages, using `<a href>` (in Stage 2, not `img`,
  `script` or `link` tags).
  - Resolve each against the final page URL and the `<base href>` if one is present.
  - Normalize: lowercase the scheme and host, drop default ports and fragments, and remove the old
    plugin's tracking parameters (`dt`, `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`,
    `utm_content`, `utm_id`, `fbclid`, `gclid`, `gad_source`, `gbraid`, `wbraid`, `mc_eid`, `_ga`,
    `_gl`, `ref`, `source`, `affiliate`, `partner`, `msclkid`, `twclid`, `li_fat_id`, `igshid`,
    `igsh`), so URLs that differ only in those merge into one row. Other query parameters are kept.
  - **Skip WordPress clutter** silently (no row), but only for links on the site's own origin:
    - any URL with a `replytocom` parameter
    - paths ending in `/feed/`, `/feed`, `/comments/feed/`
    - `/wp-login.php`, anything under `/wp-admin/`, `/xmlrpc.php`, `/wp-json/`
    - `?share=` links
    External links are never skipped this way.
  - Skip `mailto:`, `tel:`, `javascript:`, `data:` and same-page `#` anchors. These are recorded
    as `skipped` with the reason, except bare `#` anchors, which are ignored.
  - De-duplicate across the scan, keeping the first `found_in` and counting `found_count`, plus the
    first non-empty link text as `label`. Link rows use `source = page` (they were found on a
    rendered page), and pages keep their post type as `source`.
  - Stop adding new unique links at 5,000 (`truncated_reason = link_cap`).
- **Same-site links that are also pages** reuse the page result and aren't fetched twice.

**Phase 2: links.** For each unique link not already checked:
- **Same-site links:** GET (body discarded after 64 KB), 4 at a time shared with phase 1's limit.
- **External links:** HEAD first, falling back to GET when HEAD returns 405 or 501 or fails at the
  network level. At most 2 at a time per host and 16 in total, with a 10 s timeout per request.
- **One global safe-fetch call per request.** Redirects are followed by safe-fetch, so every hop is
  re-checked.

**Status buckets** (match the old screen):

| Bucket | When |
|---|---|
| `ok` | 2xx after following redirects that stay on the same URL apart from http→https or a trailing slash |
| `redirect` | 2xx reached through one or more redirects to a different URL. `detail` = final URL |
| `broken` | 404, 410, other 4xx except 401, 403 and 429; DNS failure (`dns_failed`); connection refused |
| `restricted` | 401, 403 |
| `warning` | 5xx, 429, timeout, TLS error, `too_many_redirects`, body cap hit on a page |
| `skipped` | non-http(s) scheme (`mailto:` etc.), a URL safe-fetch refuses as private or blocked (`blocked_address`, `bad_port`), invalid URL |

- **Detail text** is short and plain ("Page not found (404)", "Redirects to https://…",
  "Server error (503)", "Not checked: points to a private network address"). It never contains
  raw exception messages.

**Request identity:** `User-Agent: SiteGuardianBot/<version> (+https://siteguardian.ai/bot)`. No
cookies, and no auth headers to any host.

**Progress:** the worker updates `scan_jobs` counters at most once a second, and checks for
cancellation at the same time.

**Failure:**
- An unexpected exception marks the attempt failed, and pg-boss retries it, resuming from stored
  rows.
- After the last retry the scan is `failed` with error "The scan stopped unexpectedly. Please try
  again."
- If the site's own home page is unreachable in phase 1 (DNS or connection failure), the scan
  completes with every page `broken`. It doesn't fail. The owner sees why.

## 9. safe-fetch change: fall back to the next checked address

- **Today:** safe-fetch connects only to the first resolved address, and a Stage 1 test pins that
  behaviour ("does not fall back to a later address…").
- **Change:** after every resolved address passes the policy check (unchanged: any blocked address
  still rejects the whole request), safe-fetch tries the addresses in resolver order.
  - It moves to the next address only when the connection attempt fails before any byte of the
    request is sent: `ECONNREFUSED`, `EHOSTUNREACH`, `ENETUNREACH`, `EADDRNOTAVAIL`, or a connect
    timeout of 3 s per address.
  - The overall `timeoutMs` budget still bounds the whole call.
  - Every attempt is still pinned to one checked IP. There is no re-resolving.
- **Tests:**
  - The old "does not fall back" test is replaced.
  - New tests prove the fallback reaches the second checked address when the first refuses, that
    an unchecked address is never used, that a response from the first address (even a 5xx) isn't
    retried, and that the budget holds when every address hangs.
- **Effect:**
  - Sites with broken IPv6 can verify and be scanned.
  - The local environment would also work with `localhost` again, but it stays on `127.0.0.1`
    (no reason to change).

## 10. Browser UI

- **New screen module** `plugin/assets/js/screens/link-scanner.js`:
  - Ported from the old `link-scanner.js` (row building, badges, filters, search, summary pills,
    CSV export).
  - Rewired to the plugin REST routes, using `createApi` extended with `startLinkScan`,
    `getCurrentLinkScan`, `getLinkResults` and `cancelLinkScan`.
  - The `data-coming-soon` marker and notice are removed from the Link Scanner panel only.
- **On opening the tab:**
  - Fetch `current`.
  - If a scan is active, show progress and poll every 2 s. Back off to 5 s after 2 minutes. Stop
    polling while the tab is hidden (`visibilitychange`).
  - If the latest scan completed, load its results and show "Last scanned <relative time>" with
    **Re-scan**.
  - If the site has never scanned, show **Scan All Links**.
- **Progress:**
  - The label reads "Checking pages… 120 / 480", then "Checking links… 900 / 2,310".
  - The bar shows `processed / total`.
  - A **Cancel** button replaces the start button while a scan is running. This is new; the old
    screen had none.
- **Results:**
  - Fetched in pages of 500 until `next_cursor` is null.
  - The table is rendered with `textContent` and DOM APIs only, never `innerHTML` for data.
  - URLs in `href` are allowed only if they parse as `http:` or `https:`. Anything else is shown
    as text.
  - The rendered page stays CSP-clean.
- **Truncation notice:** shown when `truncated_reason` is set, for example "Checked the 1,000 most
  recently updated pages of 1,340. Very large sites are partly scanned for now." Similar wording
  covers the link cap and the time limit.
- **CSV:** the same columns as the old export (URL, Source, Found In, Index, Follow, Status,
  HTTP Code, Detail), with a UTF-8 BOM. Cells starting with `=`, `+`, `-` or `@` are prefixed with
  `'` so spreadsheets don't run them as formulas.
- **Errors:**
  - Session expired: the same message as chat.
  - `not_connected`: "Connect your site to Site Guardian in Settings first."
  - Rate limited: "You've started several scans recently. Please wait a bit and try again."
  - A failed scan shows its friendly `error` with **Try again**.

## 11. Security notes (in addition to rebuild spec §6)

- The browser never sends URLs, scan ids for other sites, or results. The plugin reads the scan id
  from Core's `latest`.
- Every outbound request from the worker goes through safe-fetch. That includes the owner's own
  pages, because a site's permalinks or redirects could point anywhere.
- Page-list URLs must match the site's verified origin. A compromised WordPress can make Core fetch
  only its own origin's URLs, within caps and rate limits.
- Caps, the per-site rate limits, the one-active-scan rule and the time budget together bound what
  one site can make the worker do. That stands in for credits until Stage 6.
- Scan-derived strings are stored as plain text with length caps and rendered as text. Stage 3's AI
  will treat them as untrusted data (rebuild spec §6).
- The worker uses `DATABASE_URL` (service role) and holds no Anthropic or billing secrets.

## 12. Done when

1. On the local WordPress (with a few posts, one linking to a missing page, one to an external
   404, one `mailto:`, and one page set to noindex), the owner clicks **Scan All Links**. Progress
   advances and the table shows the page rows with robots plus the link rows, with the right
   buckets.
2. Closing the tab mid-scan and reopening it shows the scan still running, then the results.
3. Killing the worker mid-scan and restarting it lets the scan finish, with no duplicate rows.
4. Clicking Scan while a scan runs shows the running scan, and no second job is created.
5. Cancel stops the scan, and the status shows cancelled.
6. A page-list URL on another host is rejected by Core (unit and integration tests). Another site's
   scan id gives 404.
7. A link to `http://127.0.0.1/…` or `http://169.254.169.254/` on a production-config scan is
   `skipped` and never fetched (worker test with a recording fetcher).
8. CSV export downloads with the old columns, and formula-looking cells are neutralized.
9. safe-fetch falls back to a second checked address when the first refuses (§9).
10. The full gate passes: typecheck, lint, unit, integration, PHPUnit and phpcs, and e2e. E2E adds
    a link-scan test against a fixture site.

## 13. Calls made by Claude (not yet confirmed by the user)

- After a cancelled or failed scan, the owner sees that status plus the last completed scan's
  results (`results_scan_id`). Cancelled and failed scans are deleted when the next one is
  created (§6).
- The plugin's page count (`pages_found`) is stored and used only for the "Checked X of Y" notice.
- The old plugin's builder and template post-type exclusions are kept, with a filter to extend
  them.
- The WordPress clutter skip list and tracking-parameter merge in §8.

- The order pages are capped in (newest modified first, home page always included) and the
  time budget (20 min).
- 2 s polling with back-off. Pausing polls while the tab is hidden.
- A Cancel button (new; the old screen had none).
- Only `<a href>` links are checked in Stage 2, not images, scripts or stylesheets.
- HEAD with GET fallback for external links, and the exact status-bucket mapping in §8.
- CSV formula neutralization.
- Rate-limit numbers in §7.
- Bot User-Agent string and URL (the URL needs a real page before launch).

## 14. Left to the builder

- The HTML parser library (it must be streaming or bounded, and tolerate bad markup; for example
  `htmlparser2`).
- The pg-boss version and its exact options (retry backoff, expiry), as long as §5's retry,
  resume and time budget hold.
- How the worker structures per-host concurrency (for example a small keyed semaphore).
- The exact friendly wording of detail strings, within §8's rules.
- Index choices beyond those named, and the exact migration layout.
