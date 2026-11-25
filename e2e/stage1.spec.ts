/**
 * Stage 1 "Done when" checks (design spec §8), against the local WordPress at :8080 and a
 * Core this file starts on :8787 (AI_STUB=true, ALLOW_LOCAL_SITES=true).
 *
 * The checks run in order on one site. "Core stopped" runs first: it needs a not-yet-connected
 * plugin, and Connect then recovers through Retry once Core is back.
 */
import { randomUUID } from "node:crypto";
import { expect, test } from "@playwright/test";
import { CORE_API, startCore, stopCore } from "./core.js";
import { collectConsoleErrors, logIn } from "./helpers.js";

const SETTINGS = "/wp-admin/options-general.php?page=site-guardian";
const APP_PAGE = "/site-health-check/";

test.describe.configure({ mode: "serial" });

test.beforeAll(async () => {
  await startCore();
});

test.afterAll(async () => {
  await stopCore();
});

test("5. with Core stopped, Connect shows the error and a Retry button", async ({ page }) => {
  await stopCore();
  try {
    await logIn(page, "admin", "admin-pass-local");
    await page.goto(SETTINGS);
    await expect(page.locator("#sg-status")).toHaveText("Not connected");

    await page.click("#sg-connect");
    await expect(page.locator("#sg-progress")).toHaveText(/Couldn't reach Site Guardian/);
    await expect(page.locator("#sg-connect")).toHaveText("Retry");
    await expect(page.locator("#sg-connect")).toBeEnabled();
  } finally {
    await startCore();
  }
});

test("1. the admin connects and sees Connected", async ({ page }) => {
  await logIn(page, "admin", "admin-pass-local");
  await page.goto(SETTINGS);
  await expect(page.locator("#sg-status")).toHaveText("Not connected");

  // After the failed attempt above, the button reads Retry.
  await page.click("#sg-connect");
  await expect(page.locator("#sg-status")).toHaveText("Connected");
});

test("2. the admin chats on /site-health-check and gets an assistant reply", async ({ page }) => {
  // CSP violations (spec §6.6: no inline scripts or styles) and script errors surface as console errors.
  const consoleErrors = collectConsoleErrors(page);

  await logIn(page, "admin", "admin-pass-local");
  const res = await page.goto(APP_PAGE);
  expect(res?.status()).toBe(200);
  expect(res?.headers()["content-security-policy"]).toContain("script-src 'self'");

  await page.fill("#sga-input", "hello");
  await page.click("#sga-send");

  await expect(page.locator(".sga-msg--user .sga-bubble", { hasText: "hello" })).toBeVisible();
  await expect(page.locator(".sga-msg--ai .sga-bubble", { hasText: "stub reply" })).toBeVisible();
  expect(consoleErrors).toEqual([]);
});

test("3. a logged-out visit to /site-health-check lands on wp-login.php", async ({ page }) => {
  await page.goto(APP_PAGE);
  await expect(page).toHaveURL(/\/wp-login\.php/);
});

test("4. a subscriber gets a 404", async ({ page }) => {
  await logIn(page, "sub", "sub-pass-local");

  const res = await page.goto(APP_PAGE);
  expect(res?.status()).toBe(404);
  await expect(page.locator("#sg-app")).toHaveCount(0);
});

test("6. registering a domain we don't control fails with verification_failed", async ({ request }) => {
  const start = await request.post(`${CORE_API}/sites/register/start`, {
    data: { installation_id: randomUUID(), site_url: "https://example.com" },
  });
  expect(start.status()).toBe(201);
  const { challenge_id } = (await start.json()) as { challenge_id: string };

  const complete = await request.post(`${CORE_API}/sites/register/complete`, { data: { challenge_id } });
  expect(complete.status()).toBe(400);
  const body = (await complete.json()) as { error: { code: string } };
  expect(body.error.code).toBe("verification_failed");
});
