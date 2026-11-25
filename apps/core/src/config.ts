import { z } from "zod";

const bool = z
  .enum(["true", "false"])
  .optional()
  .transform((v) => v === "true");

const Env = z.object({
  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  DATABASE_URL: z.string().min(1),
  ANTHROPIC_API_KEY: z.string().min(1).optional(),
  CORE_PUBLIC_URL: z.string().url(),
  PORT: z.coerce.number().int().min(1).max(65535).default(8787),
  ANTHROPIC_MODEL: z.string().min(1).default("claude-opus-5-5"),
  ALLOW_LOCAL_SITES: bool,
  AI_STUB: bool,
  TRUST_PROXY: z.coerce.number().int().min(0).default(0),
  CORS_ALLOWED_ORIGINS: z
    .string()
    .optional()
    .transform((v) =>
      (v ?? "")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  NODE_ENV: z.string().default("development"),
  LOG_LEVEL: z.string().default("info"),
});

export type Config = Omit<z.infer<typeof Env>, "ANTHROPIC_API_KEY"> & { ANTHROPIC_API_KEY?: string };

/** Validates the environment. Throws on any missing/invalid value or unsafe production flag. */
export function loadConfig(env: NodeJS.ProcessEnv): Config {
  const parsed = Env.safeParse(env);
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join(".")}: ${i.message}`).join("; ");
    throw new Error(`Invalid configuration: ${issues}`);
  }
  const c = parsed.data;
  const production = c.NODE_ENV === "production";
  if (production && c.ALLOW_LOCAL_SITES) {
    throw new Error("Invalid configuration: ALLOW_LOCAL_SITES must not be true in production");
  }
  if (production && c.AI_STUB) {
    throw new Error("Invalid configuration: AI_STUB must not be true in production");
  }
  if (!c.AI_STUB && !c.ANTHROPIC_API_KEY) {
    throw new Error("Invalid configuration: ANTHROPIC_API_KEY is required unless AI_STUB=true");
  }
  return c;
}
