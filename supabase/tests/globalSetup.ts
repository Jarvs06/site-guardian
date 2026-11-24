import { execFileSync } from "node:child_process";

const MAP: Record<string, string> = {
  SUPABASE_URL: "API_URL",
  SUPABASE_ANON_KEY: "ANON_KEY",
  SUPABASE_SERVICE_ROLE_KEY: "SERVICE_ROLE_KEY",
  DATABASE_URL: "DB_URL",
};

/** Loads local Supabase connection details from `supabase status -o env` when not already in the environment. */
export default function setup(): void {
  if (Object.keys(MAP).every((k) => process.env[k])) return;
  let out: string;
  try {
    out = execFileSync("supabase", ["status", "-o", "env"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  } catch {
    throw new Error("Supabase is not running. Run `supabase start` first (or set SUPABASE_URL, SUPABASE_ANON_KEY, SUPABASE_SERVICE_ROLE_KEY, DATABASE_URL).");
  }
  const parsed: Record<string, string> = {};
  for (const line of out.split("\n")) {
    const m = /^([A-Z_]+)="?(.*?)"?$/.exec(line.trim());
    if (m?.[1] && m[2] !== undefined) parsed[m[1]] = m[2];
  }
  for (const [envName, statusName] of Object.entries(MAP)) {
    if (process.env[envName]) continue;
    const v = parsed[statusName];
    if (!v) throw new Error(`Supabase is not running or '${statusName}' is missing from \`supabase status -o env\`.`);
    process.env[envName] = v;
  }
}
