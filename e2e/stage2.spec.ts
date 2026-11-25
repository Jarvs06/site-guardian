/**
 * Stage 2 "Done when" checks (link scan design spec §12), against the local WordPress at :8080 with
 * the fixtures from scripts/dev-setup.sh, a Core this file starts on :8787, and the link scan worker.
 *
 * The checks run in order on one site. Some stop the worker first, so the scan they start stays
 * queued until the check is ready for it to run.
 */
import { readFile } from "node:fs/promises";
import { expect, test, type Page } from "@playwright/test";
import pg from "pg";
import { startCore, startWorker, stopCore, stopWorker, supabaseEnv } from "./core.js";
import { collectConsoleErrors, logIn } from "./helpers.js";

const SETTINGS = "/wp-admin/options-general.php?page=site-guardian";
const APP_PAGE = "/site-health-check/";
const SITE = "http://127.0.0.1:8080";
const CSV_HEADER = '"URL","Source","Found In","Index","Follow","Status","HTTP Code","Detail"';

test.describe.configure({ mode: "serial" });

let db: pg.Client;

test.beforeAll(async ({ browser }) => {
  db = new pg.Client({ connectionString: supabaseEnv().DB_URL });
  await db.connect();
  await startCore();
  startWorker();

  // Stage 1's checks leave the site connected; connect it here when this file runs on its own.
  const page = await browser.newPage();
  try {
    await logIn(page, "admin", "admin-pass-local");
    await page.goto(SETTINGS);
    if ((await page.locator("#sg-status").textContent())?.trim() !== "Connected") {
      await page.click("#sg-connect");
      await expect(page.locator("#sg-status")).toHaveText("Connected");
    }
  } finally {
    await page.close();
  }
});

test.afterAll(async () => {
  await stopWorker();
  await stopCore();
  await db?.end();
});

/** Opens the app page's Link Scanner tab as the admin. */
async function openScanner(page: Page): Promise<void> {
  await logIn(page, "admin", "admin-pass-local");
  await page.goto(APP_PAGE);
  await page.click("#sg-tab-links");
  await expect(page.locator("#sg-panel-links")).toBeVisible();
}

/** The results table row for a URL (matched on the link in its URL cell, or its text when it isn't a web link). */
function row(page: Page, url: string) {
  const cell = url.startsWith("http") ? `td:first-child a[href="${url}"]` : "td:first-child";
  return page.locator("#sga-tbody tr").filter({ has: page.locator(cell, url.startsWith("http") ? {} : { hasText: url }) });
}

async function expectResults(page: Page): Promise<void> {
  await expect(page.locator("#sga-progress-wrap")).toBeHidden({ timeout: 60_000 });
  await expect(page.locator("#sga-table-wrap")).toBeVisible();
  await expect(page.locator("#sga-tbody tr").first()).toBeVisible();
}

/** GET scans/link/current through the plugin, with the page's REST nonce. */
async function currentScan(page: Page): Promise<{ scan_id?: string; status: string }> {
  return page.evaluate(async () => {
    const app = document.getElementById("sg-app") as HTMLElement;
    const res = await fetch(app.dataset.restUrl!.replace(/\/?$/, "/") + "scans/link/current", {
      headers: { "X-WP-Nonce": app.dataset.nonce ?? "" },
      credentials: "same-origin",
    });
    return (await res.json()) as { scan_id?: string; status: string };
  });
}

async function scanState(scanId: string): Promise<{ status: string; results: number }> {
  const res = await db.query<{ status: string; results: number }>(
    "select status, (select count(*)::int from link_results where scan_job_id = $1) as results from scan_jobs where id = $1",
    [scanId],
  );
  return res.rows[0] ?? { status: "deleted", results: 0 };
}

test("1. Scan All Links shows progress, then results in the right buckets", async ({ page }) => {
  await openScanner(page);
  await expect(page.locator("#sga-scan-start")).toBeVisible();

  await page.click("#sga-scan-start");
  await expect(page.locator("#sga-progress-wrap")).toBeVisible();
  await expectResults(page);

  await expect(row(page, `${SITE}/sg-missing-page/`)).toHaveAttribute("data-status", "broken");
  await expect(row(page, `${SITE}/sg-missing-page/`).locator(".sga-badge--broken")).toHaveText(/Broken/);
  await expect(row(page, "mailto:hi@example.com")).toHaveAttribute("data-status", "skipped");
  await expect(row(page, "mailto:hi@example.com").locator(".sga-badge--pending")).toHaveText(/Skipped/);
  await expect(page.locator("#sga-tbody tr", { hasText: "replytocom" })).toHaveCount(0);
  await expect(row(page, `${SITE}/sg-fixture-noindex/`).locator(".sga-badge--noindex")).toHaveText(/Noindex/);
  await expect(row(page, "https://example.com/")).toHaveAttribute("data-status", "ok");
  await expect(page.locator("#sga-last-scanned")).toHaveText(/Last scanned/);
});

test("2. reloading mid-scan shows the scan still running, then the results", async ({ page }) => {
  await stopWorker(); // the scan stays queued until the page has been reloaded
  await openScanner(page);
  await page.click("#sga-scan-refresh"); // Re-scan, after check 1's completed scan
  await expect(page.locator("#sga-scan-cancel")).toBeVisible();

  await page.reload();
  await page.click("#sg-tab-links");
  await expect(page.locator("#sga-progress-wrap")).toBeVisible();
  await expect(page.locator("#sga-scan-cancel")).toBeVisible();

  startWorker();
  await expectResults(page);
  await expect(row(page, `${SITE}/sg-missing-page/`)).toHaveAttribute("data-status", "broken");
});

test("3. a worker killed mid-scan resumes after a restart, with no duplicate rows", async ({ page }) => {
  test.setTimeout(240_000);
  await stopWorker();
  await openScanner(page);
  await page.click("#sga-scan-refresh");
  await expect(page.locator("#sga-scan-cancel")).toBeVisible();
  const { scan_id: scanId } = await currentScan(page);
  expect(scanId).toBeTruthy();

  // Kill the worker once the scan has stored some rows but hasn't finished.
  startWorker();
  await expect
    .poll(
      async () => {
        const s = await scanState(scanId!);
        return s.status === "running" && s.results > 0;
      },
      { intervals: [20], timeout: 30_000 },
    )
    .toBe(true);
  await stopWorker("SIGKILL");
  const killed = await scanState(scanId!);
  expect(killed.status, "the scan was still running when the worker was killed").toBe("running");

  startWorker();
  await expect
    .poll(async () => (await scanState(scanId!)).status, { intervals: [1000], timeout: 200_000 })
    .toBe("completed");

  await page.reload();
  await page.click("#sg-tab-links");
  await expectResults(page);
  // A URL can have one page row (source = its post type, no "found in") and one link row; no more.
  const keys = await page.locator("#sga-tbody tr").evaluateAll((rows) =>
    rows.map((tr) => {
      const url = tr.querySelector(".sga-link-url")?.textContent ?? tr.querySelector("td")?.textContent ?? "";
      const kind = tr.querySelector(".sga-found-in") ? "link" : "page";
      return `${kind} ${url}`;
    }),
  );
  expect(keys.length).toBeGreaterThan(0);
  expect(keys.length - new Set(keys).size, `duplicate rows in ${keys.join(", ")}`).toBe(0);
});

test("4. clicking Scan twice quickly starts one scan", async ({ page }) => {
  await stopWorker(); // keeps the scan active while it is checked
  await openScanner(page);
  await page.locator("#sga-scan-refresh").dblclick();
  await expect(page.locator("#sga-scan-cancel")).toBeVisible();
  const first = await currentScan(page);
  expect(first.status).toMatch(/^(queued|running)$/);

  // Starting again while it runs (as another tab would) returns the running scan.
  const again = await page.evaluate(async () => {
    const app = document.getElementById("sg-app") as HTMLElement;
    const res = await fetch(app.dataset.restUrl!.replace(/\/?$/, "/") + "scans/link", {
      method: "POST",
      headers: { "X-WP-Nonce": app.dataset.nonce ?? "" },
      credentials: "same-origin",
    });
    return (await res.json()) as { scan_id?: string };
  });
  expect(again.scan_id).toBe(first.scan_id);
  expect((await currentScan(page)).scan_id).toBe(first.scan_id);
  const active = await db.query(
    "select count(*)::int as n from scan_jobs s join websites w on w.id = s.website_id where w.origin = $1 and s.type = 'link' and s.status in ('starting', 'queued', 'running')",
    [SITE],
  );
  expect(active.rows[0].n).toBe(1);

  startWorker();
  await expectResults(page);
});

test("5. Cancel stops the scan and shows Scan cancelled", async ({ page }) => {
  await stopWorker(); // the scan can't finish before Cancel is clicked
  await openScanner(page);
  await page.click("#sga-scan-refresh");
  await page.click("#sga-scan-cancel");
  await expect(page.locator("#sga-scan-notice")).toHaveText("Scan cancelled");
  await expect(page.locator("#sga-progress-wrap")).toBeHidden();
  expect((await currentScan(page)).status).toBe("cancelled");
  startWorker();
});

test("6. Export CSV downloads the results with the old columns", async ({ page }) => {
  await openScanner(page);
  // After check 5, the cancelled scan shows the last completed scan's results.
  await expect(page.locator("#sga-table-wrap")).toBeVisible();
  const [download] = await Promise.all([page.waitForEvent("download"), page.click("#sga-scan-export")]);
  const csv = await readFile((await download.path())!, "utf8");
  expect(csv.startsWith("\uFEFF"), "UTF-8 BOM").toBe(true);
  const [header] = csv.slice(1).split("\r\n");
  expect(header).toBe(CSV_HEADER);
  expect(csv).toContain(`${SITE}/sg-missing-page/`);
});

test("7. the Link Scanner page logs no console errors (CSP)", async ({ page }) => {
  const consoleErrors = collectConsoleErrors(page);
  await openScanner(page);
  await expect(page.locator("#sga-table-wrap")).toBeVisible();
  await page.click('[data-filter-status="broken"]');
  await expect(row(page, `${SITE}/sg-missing-page/`)).toBeVisible();
  expect(consoleErrors).toEqual([]);
});
