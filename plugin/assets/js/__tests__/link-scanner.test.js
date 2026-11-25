import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ApiFailure, SessionExpiredError } from "../api.js";
import { mountLinkScanner } from "../screens/link-scanner.js";

// Same ids and classes as the Link Scanner panel of templates/app.php.
const FIXTURE = `
<section id="sg-panel-links">
<div class="sga-scanner" id="sga-scanner">
  <div class="sga-scanner-actions">
    <button id="sga-scan-start" type="button">🔍 Scan All Links</button>
    <button id="sga-scan-refresh" type="button" hidden>🔄 Re-scan</button>
    <button id="sga-scan-cancel" type="button" hidden>Cancel</button>
    <button id="sga-scan-export" type="button" hidden>📥 Export CSV</button>
  </div>
  <p id="sga-last-scanned" hidden></p>
  <p id="sga-scan-notice" role="status"></p>
  <div id="sga-progress-wrap" hidden>
    <div class="sga-progress-bar"><div class="sga-progress-fill" id="sga-progress-fill"></div></div>
    <p id="sga-progress-label"></p>
  </div>
  <div id="sga-summary" hidden>
    <span id="sga-count-total"></span><span id="sga-count-ok"></span><span id="sga-count-broken"></span>
    <span id="sga-count-restricted"></span><span id="sga-count-warning"></span><span id="sga-count-redir"></span>
    <span id="sga-count-skip"></span><span id="sga-count-indexed"></span><span id="sga-count-noindex"></span>
    <span id="sga-count-nofollow"></span>
  </div>
  <div id="sga-filter-bar" hidden>
    <button class="sga-filter-btn active" type="button" data-filter-status="all">All</button>
    <button class="sga-filter-btn" type="button" data-filter-status="broken">Broken</button>
    <button class="sga-filter-btn active" type="button" data-filter-seo="all">All</button>
    <button class="sga-filter-btn" type="button" data-filter-seo="noindex">Noindex</button>
    <input type="search" id="sga-search">
  </div>
  <div id="sga-table-wrap" hidden><table><tbody id="sga-tbody"></tbody></table></div>
</div>
</section>`;

const COUNTS = { ok: 0, broken: 0, redirect: 0, restricted: 0, warning: 0, skipped: 0, indexed: 0, noindex: 0, nofollow: 0 };

function scan(over = {}) {
  return {
    scan_id: "11111111-1111-1111-1111-111111111111",
    type: "link",
    status: "running",
    pages_total: 40,
    pages_checked: 10,
    links_total: 0,
    links_checked: 0,
    pages_submitted: 40,
    pages_found: 40,
    truncated_reason: null,
    results_scan_id: null,
    counts: { ...COUNTS },
    created_at: "2026-11-25T10:00:00Z",
    started_at: "2026-11-25T10:00:01Z",
    completed_at: null,
    error: null,
    ...over,
  };
}

function completed(over = {}) {
  return scan({
    status: "completed",
    pages_checked: 40,
    links_total: 100,
    links_checked: 100,
    results_scan_id: "11111111-1111-1111-1111-111111111111",
    completed_at: new Date(Date.now() - 5 * 60_000).toISOString(),
    counts: { ...COUNTS, ok: 2, broken: 1, indexed: 1 },
    ...over,
  });
}

function result(over = {}) {
  return {
    id: "1",
    kind: "link",
    url: "https://site.test/a",
    label: "A",
    source: "page",
    found_in: "https://site.test/",
    found_count: 1,
    status: "ok",
    http_code: 200,
    detail: null,
    robots_index: null,
    robots_follow: null,
    ...over,
  };
}

function fakeApi(overrides = {}) {
  return {
    getCurrentLinkScan: vi.fn(async () => ({ status: "none" })),
    startLinkScan: vi.fn(async () => scan({ status: "queued", pages_checked: 0 })),
    getLinkResults: vi.fn(async () => ({ items: [], next_cursor: null })),
    cancelLinkScan: vi.fn(async () => scan({ status: "cancelled" })),
    ...overrides,
  };
}

function mountFixture() {
  const doc = new DOMParser().parseFromString(FIXTURE, "text/html");
  document.body.replaceChildren(...doc.body.childNodes);
  return document.getElementById("sg-panel-links");
}

const $ = (id) => document.getElementById(id);

async function flush() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}

function setHidden(hidden) {
  Object.defineProperty(document, "hidden", { value: hidden, configurable: true });
}

let screen;

beforeEach(() => {
  vi.useFakeTimers();
  setHidden(false);
});

afterEach(() => {
  screen?.destroy();
  screen = undefined;
  vi.useRealTimers();
  document.body.replaceChildren();
});

describe("link scanner: active scan", () => {
  it("shows page progress, polls every 2 s, and skips polls while hidden", async () => {
    const api = fakeApi({ getCurrentLinkScan: vi.fn(async () => scan()) });
    screen = mountLinkScanner(mountFixture(), { api });
    await flush();

    expect($("sga-progress-wrap").hidden).toBe(false);
    expect($("sga-progress-label").textContent).toBe("Checking pages… 10 / 40");
    expect($("sga-progress-fill").style.getPropertyValue("--sga-progress")).toBe("25%");
    expect($("sga-scan-cancel").hidden).toBe(false);
    expect($("sga-scan-start").hidden).toBe(true);
    expect(api.getCurrentLinkScan).toHaveBeenCalledTimes(1);

    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(api.getCurrentLinkScan).toHaveBeenCalledTimes(2);

    setHidden(true);
    await vi.advanceTimersByTimeAsync(10_000);
    await flush();
    expect(api.getCurrentLinkScan).toHaveBeenCalledTimes(2);

    setHidden(false);
    document.dispatchEvent(new Event("visibilitychange"));
    await flush();
    expect(api.getCurrentLinkScan).toHaveBeenCalledTimes(3);
  });

  it("switches to the links label once pages are done", async () => {
    const api = fakeApi({
      getCurrentLinkScan: vi.fn(async () => scan({ pages_checked: 40, links_total: 2310, links_checked: 900 })),
    });
    screen = mountLinkScanner(mountFixture(), { api });
    await flush();
    expect($("sga-progress-label").textContent).toBe("Checking links… 900 / 2,310");
  });

  it("backs off to 5 s after 2 minutes of polling", async () => {
    const api = fakeApi({ getCurrentLinkScan: vi.fn(async () => scan()) });
    screen = mountLinkScanner(mountFixture(), { api });
    await flush();
    await vi.advanceTimersByTimeAsync(120_000);
    const calls = api.getCurrentLinkScan.mock.calls.length;
    expect(calls).toBe(61);
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.getCurrentLinkScan).toHaveBeenCalledTimes(calls);
    await vi.advanceTimersByTimeAsync(3000);
    expect(api.getCurrentLinkScan).toHaveBeenCalledTimes(calls + 1);
  });

  it("loads results when a polled scan completes, and stops polling", async () => {
    const getCurrentLinkScan = vi.fn().mockResolvedValueOnce(scan()).mockResolvedValue(completed());
    const api = fakeApi({
      getCurrentLinkScan,
      getLinkResults: vi.fn(async () => ({ items: [result()], next_cursor: null })),
    });
    screen = mountLinkScanner(mountFixture(), { api });
    await flush();
    await vi.advanceTimersByTimeAsync(2000);
    await flush();
    expect(document.querySelectorAll("#sga-tbody tr")).toHaveLength(1);
    expect($("sga-progress-wrap").hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(20_000);
    expect(getCurrentLinkScan).toHaveBeenCalledTimes(2);
  });

  it("Cancel calls cancelLinkScan and shows Scan cancelled", async () => {
    const api = fakeApi({ getCurrentLinkScan: vi.fn(async () => scan()) });
    screen = mountLinkScanner(mountFixture(), { api });
    await flush();
    $("sga-scan-cancel").click();
    await flush();
    expect(api.cancelLinkScan).toHaveBeenCalledTimes(1);
    expect($("sga-scan-notice").textContent).toBe("Scan cancelled");
    expect($("sga-scan-cancel").hidden).toBe(true);
    expect($("sga-progress-wrap").hidden).toBe(true);
    await vi.advanceTimersByTimeAsync(10_000);
    expect(api.getCurrentLinkScan).toHaveBeenCalledTimes(1);
  });
});

describe("link scanner: finished scans", () => {
  it("fetches every results page and renders one row per item", async () => {
    const getLinkResults = vi
      .fn()
      .mockResolvedValueOnce({ items: [result({ id: "1" }), result({ id: "2", url: "https://site.test/b" })], next_cursor: "2" })
      .mockResolvedValueOnce({ items: [result({ id: "3", url: "https://site.test/c", status: "broken", http_code: 404 })], next_cursor: null });
    const api = fakeApi({ getCurrentLinkScan: vi.fn(async () => completed()), getLinkResults });
    screen = mountLinkScanner(mountFixture(), { api });
    await flush();

    expect(getLinkResults).toHaveBeenCalledTimes(2);
    expect(getLinkResults.mock.calls[0][0]).toBeUndefined();
    expect(getLinkResults.mock.calls[1][0]).toBe("2");
    expect(document.querySelectorAll("#sga-tbody tr")).toHaveLength(3);
    expect($("sga-table-wrap").hidden).toBe(false);
    expect($("sga-scan-refresh").hidden).toBe(false);
    expect($("sga-scan-start").hidden).toBe(true);
    expect($("sga-scan-export").hidden).toBe(false);
    expect($("sga-last-scanned").textContent).toBe("Last scanned 5 minutes ago");
    expect($("sga-count-ok").textContent).toBe("2 OK");
    expect($("sga-count-broken").textContent).toBe("1 Broken");
    expect($("sga-count-total").textContent).toBe("3 links");
  });

  it("renders unsafe URLs and labels as text only", async () => {
    const api = fakeApi({
      getCurrentLinkScan: vi.fn(async () => completed()),
      getLinkResults: vi.fn(async () => ({
        items: [result({ url: "javascript:alert(1)", label: "<img src=x onerror=alert(1)>", found_in: "javascript:x" })],
        next_cursor: null,
      })),
    });
    screen = mountLinkScanner(mountFixture(), { api });
    await flush();

    const tbody = $("sga-tbody");
    expect(tbody.querySelector("img")).toBeNull();
    expect(tbody.querySelector("[href]")).toBeNull();
    expect(tbody.textContent).toContain("<img src=x onerror=alert(1)>");
    expect(tbody.textContent).toContain("javascript:alert(1)");
  });

  it("links http(s) URLs with noopener", async () => {
    const api = fakeApi({
      getCurrentLinkScan: vi.fn(async () => completed()),
      getLinkResults: vi.fn(async () => ({ items: [result()], next_cursor: null })),
    });
    screen = mountLinkScanner(mountFixture(), { api });
    await flush();
    const a = $("sga-tbody").querySelector("a");
    expect(a.getAttribute("href")).toBe("https://site.test/a");
    expect(a.rel).toBe("noopener noreferrer");
  });

  it("shows the exact page_cap notice", async () => {
    const api = fakeApi({
      getCurrentLinkScan: vi.fn(async () =>
        completed({ truncated_reason: "page_cap", pages_total: 1000, pages_checked: 1000, pages_found: 1340 }),
      ),
    });
    screen = mountLinkScanner(mountFixture(), { api });
    await flush();
    expect($("sga-scan-notice").textContent).toBe(
      "Checked the 1,000 most recently updated pages of 1,340. Very large sites are partly scanned for now.",
    );
  });

  it("shows the link_cap and time_limit notices", async () => {
    const api = fakeApi({ getCurrentLinkScan: vi.fn(async () => completed({ truncated_reason: "link_cap" })) });
    screen = mountLinkScanner(mountFixture(), { api });
    await flush();
    expect($("sga-scan-notice").textContent).toBe(
      "Checked the first 5,000 links. Very large sites are partly scanned for now.",
    );
    screen.destroy();

    const api2 = fakeApi({ getCurrentLinkScan: vi.fn(async () => completed({ truncated_reason: "time_limit" })) });
    screen = mountLinkScanner(mountFixture(), { api: api2 });
    await flush();
    expect($("sga-scan-notice").textContent).toBe("The scan reached its time limit. Results show what was checked.");
  });

  it("filters rows by status, SEO and search", async () => {
    const api = fakeApi({
      getCurrentLinkScan: vi.fn(async () => completed()),
      getLinkResults: vi.fn(async () => ({
        items: [
          result({ id: "1", url: "https://site.test/ok" }),
          result({ id: "2", url: "https://site.test/gone", status: "broken" }),
          result({ id: "3", kind: "page", source: "post", url: "https://site.test/hidden-page", robots_index: "noindex", robots_follow: "follow" }),
        ],
        next_cursor: null,
      })),
    });
    screen = mountLinkScanner(mountFixture(), { api });
    await flush();
    const visible = () => [...document.querySelectorAll("#sga-tbody tr")].filter((tr) => !tr.hidden).length;

    expect(visible()).toBe(3);
    document.querySelector('[data-filter-status="broken"]').click();
    expect(visible()).toBe(1);
    expect(document.querySelector('[data-filter-status="broken"]').classList.contains("active")).toBe(true);
    document.querySelector('[data-filter-status="all"]').click();
    document.querySelector('[data-filter-seo="noindex"]').click();
    expect(visible()).toBe(1);
    document.querySelector('[data-filter-seo="all"]').click();
    const search = $("sga-search");
    search.value = "GONE";
    search.dispatchEvent(new Event("input"));
    expect(visible()).toBe(1);
  });

  it("shows a failed scan's error with Try again, and the previous results", async () => {
    const api = fakeApi({
      getCurrentLinkScan: vi.fn(async () =>
        scan({ status: "failed", error: "The scan could not finish.", results_scan_id: "22222222-2222-2222-2222-222222222222" }),
      ),
      getLinkResults: vi.fn(async () => ({ items: [result()], next_cursor: null })),
    });
    screen = mountLinkScanner(mountFixture(), { api });
    await flush();
    expect($("sga-scan-notice").textContent).toBe("The scan could not finish.");
    expect($("sga-scan-start").hidden).toBe(false);
    expect($("sga-scan-start").textContent).toBe("Try again");
    expect(document.querySelectorAll("#sga-tbody tr")).toHaveLength(1);
  });

  it("shows Scan cancelled with the previous results", async () => {
    const api = fakeApi({
      getCurrentLinkScan: vi.fn(async () =>
        scan({ status: "cancelled", results_scan_id: "22222222-2222-2222-2222-222222222222" }),
      ),
      getLinkResults: vi.fn(async () => ({ items: [result(), result({ id: "2" })], next_cursor: null })),
    });
    screen = mountLinkScanner(mountFixture(), { api });
    await flush();
    expect($("sga-scan-notice").textContent).toBe("Scan cancelled");
    expect(document.querySelectorAll("#sga-tbody tr")).toHaveLength(2);
  });

  it("shows the start button when the site never scanned", async () => {
    const api = fakeApi();
    screen = mountLinkScanner(mountFixture(), { api });
    await flush();
    expect($("sga-scan-start").hidden).toBe(false);
    expect($("sga-scan-cancel").hidden).toBe(true);
    expect($("sga-table-wrap").hidden).toBe(true);
    expect(api.getLinkResults).not.toHaveBeenCalled();
  });
});

describe("link scanner: starting and errors", () => {
  it("starts a scan and polls it", async () => {
    const api = fakeApi();
    screen = mountLinkScanner(mountFixture(), { api });
    await flush();
    $("sga-scan-start").click();
    await flush();
    expect(api.startLinkScan).toHaveBeenCalledTimes(1);
    expect($("sga-scan-cancel").hidden).toBe(false);
    expect($("sga-progress-wrap").hidden).toBe(false);
    await vi.advanceTimersByTimeAsync(2000);
    expect(api.getCurrentLinkScan).toHaveBeenCalledTimes(2);
  });

  it("shows the rate-limit message when starting is rate limited", async () => {
    const api = fakeApi({
      startLinkScan: vi.fn(async () => {
        throw new ApiFailure("rate_limited", "Too many requests.", 429);
      }),
    });
    screen = mountLinkScanner(mountFixture(), { api });
    await flush();
    $("sga-scan-start").click();
    await flush();
    expect($("sga-scan-notice").textContent).toBe(
      "You've started several scans recently. Please wait a bit and try again.",
    );
    expect($("sga-scan-start").hidden).toBe(false);
    expect($("sga-scan-start").disabled).toBe(false);
    expect($("sga-progress-wrap").hidden).toBe(true);
  });

  it("shows the not-connected and session-expired messages", async () => {
    const api = fakeApi({
      getCurrentLinkScan: vi.fn(async () => {
        throw new ApiFailure("not_connected", "Not connected.", 503);
      }),
    });
    screen = mountLinkScanner(mountFixture(), { api });
    await flush();
    expect($("sga-scan-notice").textContent).toBe("Connect your site to Site Guardian in Settings first.");
    screen.destroy();

    const api2 = fakeApi({
      getCurrentLinkScan: vi.fn(async () => {
        throw new SessionExpiredError();
      }),
    });
    screen = mountLinkScanner(mountFixture(), { api: api2 });
    await flush();
    expect($("sga-scan-notice").textContent).toBe("Your session expired — please refresh the page.");
  });

  it("exports the loaded rows as site-guardian-links.csv", async () => {
    const api = fakeApi({
      getCurrentLinkScan: vi.fn(async () => completed()),
      getLinkResults: vi.fn(async () => ({ items: [result()], next_cursor: null })),
    });
    const created = [];
    URL.createObjectURL = vi.fn((blob) => {
      created.push(blob);
      return "blob:x";
    });
    URL.revokeObjectURL = vi.fn();
    const clicks = [];
    const click = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(function () {
      clicks.push(this.download);
    });
    screen = mountLinkScanner(mountFixture(), { api });
    await flush();
    $("sga-scan-export").click();
    expect(clicks).toEqual(["site-guardian-links.csv"]);
    expect(created[0]).toBeInstanceOf(Blob);
    vi.useRealTimers(); // FileReader completes on a timer
    const text = await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result);
      reader.readAsText(created[0]);
    });
    expect(text).toContain("https://site.test/a");
    click.mockRestore();
  });
});
