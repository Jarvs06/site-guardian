/**
 * Runs Core on the host for the e2e checks, so a test can stop and restart it.
 * Config comes from the local Supabase (`supabase status -o env`), with the dev-only
 * flags the checks need: AI_STUB (canned replies) and ALLOW_LOCAL_SITES (the site is http://127.0.0.1:8080).
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const CORE_PORT = 8787;
export const CORE_URL = `http://127.0.0.1:${CORE_PORT}`;
export const CORE_API = `${CORE_URL}/api/v1`;

const SERVER_JS = `${REPO_ROOT}apps/core/dist/server.js`;

/** Reads `supabase status -o env` (KEY="value" lines). */
export function supabaseEnv(): Record<string, string> {
  const out = execFileSync("supabase", ["status", "-o", "env"], { cwd: REPO_ROOT, encoding: "utf8" });
  const env: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const m = /^([A-Z0-9_]+)="?(.*?)"?$/.exec(line.trim());
    if (m?.[1] && m[2] !== undefined) env[m[1]] = m[2];
  }
  for (const key of ["API_URL", "SERVICE_ROLE_KEY", "DB_URL"]) {
    if (!env[key]) throw new Error(`supabase status is missing ${key}: is local Supabase running (supabase start)?`);
  }
  return env;
}

export function coreEnv(): NodeJS.ProcessEnv {
  const sb = supabaseEnv();
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: "development",
    PORT: String(CORE_PORT),
    SUPABASE_URL: sb.API_URL,
    SUPABASE_SERVICE_ROLE_KEY: sb.SERVICE_ROLE_KEY,
    DATABASE_URL: sb.DB_URL,
    CORE_PUBLIC_URL: `http://localhost:${CORE_PORT}`,
    ALLOW_LOCAL_SITES: "true",
    AI_STUB: "true",
    LOG_LEVEL: "warn",
  };
}

export async function isUp(): Promise<boolean> {
  try {
    const res = await fetch(`${CORE_API}/health`, { signal: AbortSignal.timeout(1000) });
    return res.ok;
  } catch {
    return false;
  }
}

let child: ChildProcess | null = null;

export async function startCore(): Promise<void> {
  if (child) return;
  if (await isUp()) {
    throw new Error(`Something is already serving ${CORE_URL}: stop it, the e2e run manages its own Core.`);
  }
  const proc = spawn(process.execPath, [SERVER_JS], { cwd: REPO_ROOT, env: coreEnv(), stdio: ["ignore", "inherit", "inherit"] });
  child = proc;
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) throw new Error(`Core exited during startup (code ${proc.exitCode}).`);
    if (await isUp()) return;
    await new Promise((r) => setTimeout(r, 200));
  }
  await stopCore();
  throw new Error("Core did not become healthy within 15s.");
}

export async function stopCore(): Promise<void> {
  const proc = child;
  child = null;
  if (!proc || proc.exitCode !== null) return;
  const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
  proc.kill("SIGTERM");
  const timer = setTimeout(() => proc.kill("SIGKILL"), 5000);
  await exited;
  clearTimeout(timer);
}
