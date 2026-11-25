/**
 * Link Scanner screen — ported from the old link-scanner.js (rows, badges, filters, search,
 * summary pills, CSV export), rewired to the plugin's scans/link REST routes. The scan runs in
 * Site Guardian's worker; this screen starts it, polls its status and shows its results.
 *
 * Scan data is untrusted: it is rendered with textContent only, and only http(s) URLs become links.
 */
import { ApiFailure, SessionExpiredError } from "../api.js";
import { toCsv } from "../csv.js";

const FAST_POLL_MS = 2000;
const SLOW_POLL_MS = 5000;
const FAST_POLL_FOR_MS = 120_000;
const MAX_RESULT_PAGES = 100;
const ACTIVE = new Set(["starting", "queued", "running"]);

const SESSION_EXPIRED_MESSAGE = "Your session expired — please refresh the page.";
const NOT_CONNECTED_MESSAGE = "Connect your site to Site Guardian in Settings first.";
const RATE_LIMITED_MESSAGE = "You've started several scans recently. Please wait a bit and try again.";
const GENERIC_MESSAGE = "Something went wrong. Please try again.";
const CANCELLED_MESSAGE = "Scan cancelled";
const TRY_AGAIN_LABEL = "Try again";
const CSV_NAME = "site-guardian-links.csv";

const STATUS_BADGES = {
  ok: ["✅ OK", "sga-badge--ok"],
  broken: ["❌ Broken", "sga-badge--broken"],
  redirect: ["↪ Redirect", "sga-badge--redir"],
  restricted: ["🔒 Restricted", "sga-badge--restricted"],
  warning: ["⚠️ Warning", "sga-badge--warning"],
  skipped: ["⏭ Skipped", "sga-badge--pending"],
};

/** @param {number} n */
const fmt = (n) => Number(n || 0).toLocaleString("en-US");

/** @param {unknown} u */
function isWebUrl(u) {
  try {
    const protocol = new URL(String(u)).protocol;
    return protocol === "http:" || protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * @param {string|null} iso
 * @param {number} now
 */
function relativeTime(iso, now) {
  const t = iso ? Date.parse(iso) : NaN;
  if (Number.isNaN(t)) return "";
  const sec = Math.round((t - now) / 1000);
  if (Math.abs(sec) < 60) return "just now";
  const rtf = new Intl.RelativeTimeFormat("en", { numeric: "auto" });
  if (Math.abs(sec) < 3600) return rtf.format(Math.round(sec / 60), "minute");
  if (Math.abs(sec) < 86_400) return rtf.format(Math.round(sec / 3600), "hour");
  return rtf.format(Math.round(sec / 86_400), "day");
}

/** @param {any} s ScanStatus */
function truncationNotice(s) {
  switch (s.truncated_reason) {
    case "page_cap":
      return `Checked the ${fmt(s.pages_total)} most recently updated pages of ${fmt(s.pages_found ?? s.pages_total)}. Very large sites are partly scanned for now.`;
    case "link_cap":
      return "Checked the first 5,000 links. Very large sites are partly scanned for now.";
    case "time_limit":
      return "The scan reached its time limit. Results show what was checked.";
    default:
      return "";
  }
}

/**
 * Single SEO key for filtering. Priority: noindex > nofollow > indexed > unknown.
 * @param {any} item LinkResult
 */
function seoKey(item) {
  if (!item.robots_index && !item.robots_follow) return "unknown";
  if (item.robots_index === "noindex") return "noindex";
  if (item.robots_follow === "nofollow") return "nofollow";
  return "indexed";
}

/**
 * @param {Element} root  The Link Scanner panel.
 * @param {{ api: { startLinkScan: Function, getCurrentLinkScan: Function, getLinkResults: Function,
 *   cancelLinkScan: Function }, setTimeout?: (fn: () => void, ms: number) => unknown, document?: Document }} deps
 * @returns {{ destroy(): void }}
 */
export function mountLinkScanner(root, deps) {
  const { api } = deps;
  const doc = deps.document ?? root.ownerDocument;
  const schedule = deps.setTimeout ?? ((fn, ms) => globalThis.setTimeout(fn, ms));
  /** @param {string} id */
  const $ = (id) => /** @type {HTMLElement} */ (root.querySelector("#" + id));

  const startBtn = /** @type {HTMLButtonElement} */ ($("sga-scan-start"));
  const refreshBtn = /** @type {HTMLButtonElement} */ ($("sga-scan-refresh"));
  const cancelBtn = /** @type {HTMLButtonElement} */ ($("sga-scan-cancel"));
  const exportBtn = /** @type {HTMLButtonElement} */ ($("sga-scan-export"));
  const lastScannedEl = $("sga-last-scanned");
  const noticeEl = $("sga-scan-notice");
  const progressWrap = $("sga-progress-wrap");
  const progressFill = $("sga-progress-fill");
  const progressLabel = $("sga-progress-label");
  const summaryEl = $("sga-summary");
  const filterBar = $("sga-filter-bar");
  const tableWrap = $("sga-table-wrap");
  const tbody = $("sga-tbody");
  const searchInput = /** @type {HTMLInputElement} */ ($("sga-search"));
  const statusBtns = /** @type {HTMLElement[]} */ ([...root.querySelectorAll("[data-filter-status]")]);
  const seoBtns = /** @type {HTMLElement[]} */ ([...root.querySelectorAll("[data-filter-seo]")]);
  const startLabel = startBtn.textContent?.trim() ?? "";

  /** @type {{ tr: HTMLTableRowElement, item: any, seo: string, url: string }[]} */
  let rows = [];
  let statusFilter = "all";
  let seoFilter = "all";
  // Bumped whenever polling stops or the user acts; stale timers and responses check it.
  let gen = 0;
  let pollElapsed = 0;
  let paused = false;
  let destroyed = false;
  const listeners = new AbortController();
  const on = { signal: listeners.signal };

  startBtn.addEventListener("click", () => void start(), on);
  refreshBtn.addEventListener("click", () => void start(), on);
  cancelBtn.addEventListener("click", () => void cancel(), on);
  exportBtn.addEventListener("click", exportCsv, on);
  searchInput.addEventListener("input", applyFilter, on);
  for (const btn of statusBtns) {
    btn.addEventListener(
      "click",
      () => {
        statusFilter = btn.dataset.filterStatus ?? "all";
        for (const b of statusBtns) b.classList.toggle("active", b === btn);
        applyFilter();
      },
      on,
    );
  }
  for (const btn of seoBtns) {
    btn.addEventListener(
      "click",
      () => {
        seoFilter = btn.dataset.filterSeo ?? "all";
        for (const b of seoBtns) b.classList.toggle("active", b === btn);
        applyFilter();
      },
      on,
    );
  }
  doc.addEventListener(
    "visibilitychange",
    () => {
      if (!doc.hidden && paused) {
        paused = false;
        void poll();
      }
    },
    on,
  );

  void (async () => {
    const g = gen;
    try {
      const s = await api.getCurrentLinkScan();
      if (g === gen && !destroyed) render(s);
    } catch (err) {
      if (g === gen && !destroyed) fail(err, false);
    }
  })();

  /* ── State rendering ── */

  /** @param {any} s ScanStatus or {status: "none"} */
  function render(s) {
    stopPolling();
    if (!s || !s.status || s.status === "none") {
      hideProgress();
      setButtons("idle");
      return;
    }
    if (ACTIVE.has(s.status)) {
      setNotice("");
      lastScannedEl.hidden = true;
      clearResults();
      showProgress(s);
      setButtons("active");
      schedulePoll();
      return;
    }
    hideProgress();
    if (s.status === "completed") {
      setNotice(truncationNotice(s));
      const when = relativeTime(s.completed_at, Date.now());
      lastScannedEl.textContent = when ? "Last scanned " + when : "";
      lastScannedEl.hidden = !when;
      setButtons("completed");
      void loadResults(s);
      return;
    }
    lastScannedEl.hidden = true;
    if (s.status === "failed") {
      setNotice(typeof s.error === "string" && s.error ? s.error : GENERIC_MESSAGE, true);
      setButtons("failed");
    } else {
      setNotice(CANCELLED_MESSAGE);
      setButtons("idle");
    }
    if (s.results_scan_id) void loadResults(s);
    else clearResults();
  }

  /** @param {"idle"|"active"|"completed"|"failed"} mode */
  function setButtons(mode) {
    startBtn.hidden = !(mode === "idle" || mode === "failed");
    startBtn.textContent = mode === "failed" ? TRY_AGAIN_LABEL : startLabel;
    refreshBtn.hidden = mode !== "completed";
    cancelBtn.hidden = mode !== "active";
    exportBtn.hidden = mode === "active" || rows.length === 0;
  }

  /**
   * @param {string} text
   * @param {boolean} [isError]
   */
  function setNotice(text, isError = false) {
    noticeEl.textContent = text;
    noticeEl.classList.toggle("sga-scan-notice--error", isError && !!text);
  }

  /** @param {any} s ScanStatus */
  function showProgress(s) {
    let checked = 0;
    let total = 0;
    let label;
    if (s.status !== "running") {
      label = "Starting scan…";
    } else if (s.pages_checked < s.pages_total) {
      [checked, total] = [s.pages_checked, s.pages_total];
      label = `Checking pages… ${fmt(checked)} / ${fmt(total)}`;
    } else {
      [checked, total] = [s.links_checked, s.links_total];
      label = `Checking links… ${fmt(checked)} / ${fmt(total)}`;
    }
    setProgress(label, total > 0 ? Math.min(100, Math.round((checked / total) * 100)) : 0);
  }

  /**
   * @param {string} label
   * @param {number} pct
   */
  function setProgress(label, pct) {
    progressWrap.hidden = false;
    progressLabel.textContent = label;
    // CSSOM custom property: allowed by the page CSP (style attributes in markup are not).
    progressFill.style.setProperty("--sga-progress", pct + "%");
  }

  function hideProgress() {
    progressWrap.hidden = true;
  }

  /* ── Polling ── */

  function schedulePoll() {
    if (destroyed) return;
    const g = gen;
    const ms = pollElapsed < FAST_POLL_FOR_MS ? FAST_POLL_MS : SLOW_POLL_MS;
    schedule(() => {
      if (g !== gen || destroyed) return;
      pollElapsed += ms;
      if (doc.hidden) {
        paused = true;
        return;
      }
      void poll();
    }, ms);
  }

  function stopPolling() {
    gen++;
    paused = false;
  }

  async function poll() {
    const g = gen;
    try {
      const s = await api.getCurrentLinkScan();
      if (g === gen && !destroyed) render(s);
    } catch (err) {
      if (g !== gen || destroyed) return;
      if (isFatal(err)) {
        fail(err, false);
      } else {
        setNotice(errorMessage(err, false), true);
        schedulePoll();
      }
    }
  }

  /* ── Actions ── */

  async function start() {
    stopPolling();
    const g = gen;
    pollElapsed = 0;
    setNotice("");
    lastScannedEl.hidden = true;
    clearResults();
    setButtons("idle");
    startBtn.hidden = false;
    startBtn.textContent = startLabel;
    startBtn.disabled = true;
    refreshBtn.disabled = true;
    setProgress("Starting scan…", 0);
    try {
      const s = await api.startLinkScan();
      if (g === gen && !destroyed) render(s);
    } catch (err) {
      if (g === gen && !destroyed) fail(err, true);
    } finally {
      startBtn.disabled = false;
      refreshBtn.disabled = false;
    }
  }

  async function cancel() {
    stopPolling();
    const g = gen;
    cancelBtn.disabled = true;
    try {
      const s = await api.cancelLinkScan();
      if (g === gen && !destroyed) render(s);
    } catch (err) {
      if (g !== gen || destroyed) return;
      if (isFatal(err)) {
        fail(err, false);
      } else {
        setNotice(errorMessage(err, false), true);
        schedulePoll();
      }
    } finally {
      cancelBtn.disabled = false;
    }
  }

  /**
   * Show an error and return to the idle state.
   * @param {unknown} err
   * @param {boolean} starting
   */
  function fail(err, starting) {
    stopPolling();
    hideProgress();
    setButtons("idle");
    setNotice(errorMessage(err, starting), true);
  }

  /* ── Results ── */

  /** @param {any} s ScanStatus whose results_scan_id results to load */
  async function loadResults(s) {
    const g = gen;
    clearResults();
    /** @type {any[]} */
    const items = [];
    /** @type {string|null|undefined} */
    let cursor = undefined;
    try {
      for (let page = 0; page < MAX_RESULT_PAGES; page++) {
        const res = await api.getLinkResults(cursor);
        if (g !== gen || destroyed) return;
        items.push(...res.items);
        if (!res.next_cursor || res.next_cursor === cursor) break;
        cursor = res.next_cursor;
      }
    } catch (err) {
      if (g === gen && !destroyed) setNotice(errorMessage(err, false), true);
      return;
    }
    renderResults(items, s.counts);
  }

  function clearResults() {
    rows = [];
    tbody.replaceChildren();
    summaryEl.hidden = true;
    filterBar.hidden = true;
    tableWrap.hidden = true;
    exportBtn.hidden = true;
  }

  /**
   * @param {any[]} items
   * @param {any} counts
   */
  function renderResults(items, counts) {
    const frag = doc.createDocumentFragment();
    rows = items.map((item) => {
      const tr = buildRow(item);
      frag.appendChild(tr);
      return { tr, item, seo: seoKey(item), url: String(item.url).toLowerCase() };
    });
    tbody.replaceChildren(frag);
    renderPills(counts ?? {});
    summaryEl.hidden = false;
    filterBar.hidden = false;
    tableWrap.hidden = false;
    exportBtn.hidden = rows.length === 0;
    applyFilter();
  }

  /** @param {any} c ScanStatus counts */
  function renderPills(c) {
    const total = ["ok", "broken", "redirect", "restricted", "warning", "skipped"].reduce((n, k) => n + (c[k] || 0), 0);
    const pills = {
      "sga-count-total": fmt(total) + " links",
      "sga-count-ok": fmt(c.ok) + " OK",
      "sga-count-broken": fmt(c.broken) + " Broken",
      "sga-count-restricted": fmt(c.restricted) + " Restricted",
      "sga-count-warning": fmt(c.warning) + " Warning",
      "sga-count-redir": fmt(c.redirect) + " Redirect",
      "sga-count-skip": fmt(c.skipped) + " Skipped",
      "sga-count-indexed": fmt(c.indexed) + " Indexed",
      "sga-count-noindex": fmt(c.noindex) + " Noindex",
      "sga-count-nofollow": fmt(c.nofollow) + " Nofollow",
    };
    for (const [id, text] of Object.entries(pills)) {
      const el = root.querySelector("#" + id);
      if (el) el.textContent = text;
    }
  }

  function applyFilter() {
    const query = (searchInput.value || "").toLowerCase();
    for (const { tr, item, seo, url } of rows) {
      const matchStatus = statusFilter === "all" || item.status === statusFilter;
      const matchSeo = seoFilter === "all" || seo === seoFilter;
      const matchSearch = !query || url.includes(query);
      tr.hidden = !(matchStatus && matchSeo && matchSearch);
    }
  }

  /* ── Row building (DOM + textContent only) ── */

  /**
   * @param {string} tag
   * @param {string} [className]
   * @param {string} [text]
   */
  function make(tag, className, text) {
    const el = doc.createElement(tag);
    if (className) el.className = className;
    if (text !== undefined) el.textContent = text;
    return el;
  }

  /**
   * A link when the URL is http(s), plain text otherwise.
   * @param {string} url
   * @param {string} className
   * @param {string} text
   */
  function linkOrText(url, className, text) {
    if (!isWebUrl(url)) return make("span", className, text);
    const a = /** @type {HTMLAnchorElement} */ (make("a", className, text));
    a.href = url;
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    return a;
  }

  /** @param {any} item LinkResult */
  function buildRow(item) {
    const url = String(item.url ?? "");
    const label = typeof item.label === "string" && item.label ? item.label : "";
    const tr = /** @type {HTMLTableRowElement} */ (make("tr"));
    tr.dataset.status = String(item.status);
    tr.dataset.seo = seoKey(item);

    const tdUrl = make("td");
    tdUrl.appendChild(linkOrText(url, "sga-link-label", label || url));
    if (label && label !== url) tdUrl.appendChild(make("div", "sga-link-url", url));

    const tdSource = make("td", "sga-col-source");
    tdSource.appendChild(make("span", "", String(item.source ?? "") || "—"));
    if (item.found_in) {
      tdSource.appendChild(make("br"));
      const foundIn = linkOrText(String(item.found_in), "sga-found-in", String(item.found_in));
      foundIn.title = "Open the page where this link was found";
      tdSource.appendChild(foundIn);
    }

    const tdRobots = make("td", "sga-col-robots");
    if (!item.robots_index && !item.robots_follow) {
      const na = make("span", "sga-badge sga-badge--robots-unknown", "— N/A");
      na.title = "Not applicable";
      tdRobots.appendChild(na);
    } else {
      const wrap = make("div", "sga-robots-wrap");
      wrap.appendChild(
        item.robots_index === "noindex"
          ? make("span", "sga-badge sga-badge--noindex", "🚫 Noindex")
          : make("span", "sga-badge sga-badge--indexed", "✅ Index"),
      );
      wrap.appendChild(
        item.robots_follow === "nofollow"
          ? make("span", "sga-badge sga-badge--nofollow", "🚫 Nofollow")
          : make("span", "sga-badge sga-badge--follow", "✅ Follow"),
      );
      tdRobots.appendChild(wrap);
    }

    const tdStatus = make("td", "sga-col-status");
    const [text, cls] = STATUS_BADGES[/** @type {keyof typeof STATUS_BADGES} */ (item.status)] ?? [
      String(item.status),
      "",
    ];
    const code = item.http_code ? " " + item.http_code : "";
    tdStatus.appendChild(make("span", ("sga-badge " + cls).trim(), text + code));
    if (item.detail) tdStatus.appendChild(make("span", "sga-badge-detail", " — " + String(item.detail)));

    tr.append(tdUrl, tdSource, tdRobots, tdStatus);
    return tr;
  }

  /* ── Export ── */

  function exportCsv() {
    if (rows.length === 0) return;
    const blob = new Blob([toCsv(rows.map((r) => r.item))], { type: "text/csv;charset=utf-8" });
    const href = URL.createObjectURL(blob);
    const a = /** @type {HTMLAnchorElement} */ (doc.createElement("a"));
    a.href = href;
    a.download = CSV_NAME;
    doc.body.appendChild(a);
    a.click();
    a.remove();
    schedule(() => URL.revokeObjectURL(href), 0);
  }

  /* ── Errors ── */

  /** @param {unknown} err */
  function isFatal(err) {
    return err instanceof SessionExpiredError || (err instanceof ApiFailure && err.code === "not_connected");
  }

  /**
   * @param {unknown} err
   * @param {boolean} starting
   */
  function errorMessage(err, starting) {
    if (err instanceof SessionExpiredError) return SESSION_EXPIRED_MESSAGE;
    if (err instanceof ApiFailure) {
      if (err.code === "not_connected") return NOT_CONNECTED_MESSAGE;
      if (err.code === "rate_limited" && starting) return RATE_LIMITED_MESSAGE;
      if (err.message) return err.message;
    }
    return GENERIC_MESSAGE;
  }

  return {
    destroy() {
      destroyed = true;
      stopPolling();
      listeners.abort();
    },
  };
}
