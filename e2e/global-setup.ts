/**
 * Before the checks: confirm WordPress is up, build Core, and reset the state earlier runs left
 * behind (the plugin's connection options, the per-IP registration rate limits in the LOCAL database).
 */
import { execFileSync } from "node:child_process";
import pg from "pg";
import { REPO_ROOT, supabaseEnv } from "./core.js";

const WP_URL = "http://127.0.0.1:8080";

const PLUGIN_STATE_OPTIONS = [
  "site_guardian_website_id",
  "site_guardian_credential",
  "site_guardian_pending_challenge",
  "site_guardian_last_error",
  "site_guardian_connect_lock",
];

export default async function globalSetup(): Promise<void> {
  const wp = await fetch(`${WP_URL}/wp-login.php`).catch(() => null);
  if (!wp?.ok) {
    throw new Error(`WordPress is not reachable at ${WP_URL}: run 'docker compose up -d && scripts/dev-setup.sh'.`);
  }

  execFileSync("pnpm", ["--filter", "@sg/shared", "--filter", "@sg/core", "build"], { cwd: REPO_ROOT, stdio: "inherit" });

  for (const option of PLUGIN_STATE_OPTIONS) {
    // `wp option delete` exits 1 when the option is absent; that is fine.
    try {
      execFileSync("docker", ["compose", "run", "--rm", "-T", "wpcli", "wp", "option", "delete", option], {
        cwd: REPO_ROOT,
        stdio: "ignore",
      });
    } catch {
      /* absent */
    }
  }

  const dbUrl = supabaseEnv().DB_URL as string;
  const host = new URL(dbUrl).hostname;
  if (host !== "127.0.0.1" && host !== "localhost") {
    throw new Error(`Refusing to reset rate limits on a non-local database (${host}).`);
  }
  const client = new pg.Client({ connectionString: dbUrl });
  await client.connect();
  try {
    await client.query("delete from rate_limits where key like 'sites-register-%'");
  } finally {
    await client.end();
  }
}
