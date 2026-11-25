/**
 * Runs Core and the link scan worker on the host for the e2e checks, so a test can stop and restart them.
 * Config comes from the local Supabase (`supabase status -o env`), with the dev-only flags the checks
 * need: AI_STUB (canned replies) and ALLOW_LOCAL_SITES (the site is http://127.0.0.1:8080).
 */
import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";

export const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
export const CORE_PORT = 8787;
export const CORE_URL = `http://127.0.0.1:${CORE_PORT}`;
export const CORE_API = `${CORE_URL}/api/v1`;

const SERVER_JS = `${REPO_ROOT}apps/core/dist/server.js`;
const WORKER_JS = `${REPO_ROOT}apps/worker/dist/main.js`;

let cachedEnv: Record<string, string> | undefined;

/** Reads `supabase status -o env` (KEY="value" lines), once per process. */
export function supabaseEnv(): Record<string, string> {
  if (cachedEnv) return cachedEnv;
  // stderr is dropped: the CLI prints its stopped-services list and update notices there.
  const out = execFileSync("supabase", ["status", "-o", "env"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  const env: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const m = /^([A-Z0-9_]+)="?(.*?)"?$/.exec(line.trim());
    if (m?.[1] && m[2] !== undefined) env[m[1]] = m[2];
  }
  for (const key of ["API_URL", "SERVICE_ROLE_KEY", "DB_URL"]) {
    if (!env[key]) throw new Error(`supabase status is missing ${key}: is local Supabase running (supabase start)?`);
  }
  cachedEnv = env;
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

export function workerEnv(): NodeJS.ProcessEnv {
  return {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: "development",
    DATABASE_URL: supabaseEnv().DB_URL,
    ALLOW_LOCAL_SITES: "true",
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

let core: ChildProcess | null = null;
let worker: ChildProcess | null = null;

function spawnNode(script: string, env: NodeJS.ProcessEnv): ChildProcess {
  return spawn(process.execPath, [script], { cwd: REPO_ROOT, env, stdio: ["ignore", "inherit", "inherit"] });
}

/** Signals a process and waits for it to exit (SIGKILL after 5 s if a SIGTERM isn't enough). */
async function stopProcess(proc: ChildProcess | null, signal: NodeJS.Signals): Promise<void> {
  if (!proc || proc.exitCode !== null || proc.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => proc.once("exit", () => resolve()));
  proc.kill(signal);
  const timer = setTimeout(() => proc.kill("SIGKILL"), 5000);
  await exited;
  clearTimeout(timer);
}

export async function startCore(): Promise<void> {
  if (core) return;
  if (await isUp()) {
    throw new Error(`Something is already serving ${CORE_URL}: stop it, the e2e run manages its own Core.`);
  }
  const proc = spawnNode(SERVER_JS, coreEnv());
  core = proc;
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
  const proc = core;
  core = null;
  await stopProcess(proc, "SIGTERM");
}

/** Starts the link scan worker (it has no health endpoint; it picks up queued jobs once pg-boss starts). */
export function startWorker(): void {
  if (worker) return;
  worker = spawnNode(WORKER_JS, workerEnv());
}

/** Stops the worker: SIGTERM is a graceful stop, SIGKILL simulates a crash. */
export async function stopWorker(signal: NodeJS.Signals = "SIGTERM"): Promise<void> {
  const proc = worker;
  worker = null;
  await stopProcess(proc, signal);
}
