/** Shared e2e helpers. */
import { expect, type Page } from "@playwright/test";

/**
 * Logs in by posting the login form through the page's request context (it shares the browser's
 * cookies). Filling the form in the browser races wp-login.php's focus script, which clears the
 * fields shortly after load.
 */
export async function logIn(page: Page, user: string, pass: string): Promise<void> {
  await page.request.get("/wp-login.php"); // sets wordpress_test_cookie
  const res = await page.request.post("/wp-login.php", {
    form: { log: user, pwd: pass, "wp-submit": "Log In", testcookie: "1" },
    maxRedirects: 0,
  });
  expect(res.status(), `login as ${user}`).toBe(302);
}

/** Collects console errors and page errors (CSP violations surface as console errors). */
export function collectConsoleErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));
  return errors;
}
