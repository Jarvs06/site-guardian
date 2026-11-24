import { describe, expect, it } from "vitest";
import { loadConfig } from "./config.js";

const valid = {
  SUPABASE_URL: "http://127.0.0.1:54321",
  SUPABASE_SERVICE_ROLE_KEY: "service-role",
  DATABASE_URL: "postgres://u:p@127.0.0.1:54322/postgres",
  ANTHROPIC_API_KEY: "sk-test",
  CORE_PUBLIC_URL: "https://core.example.test",
};

describe("loadConfig", () => {
  it("applies defaults", () => {
    const c = loadConfig(valid);
    expect(c.PORT).toBe(8787);
    expect(c.ANTHROPIC_MODEL).toBe("claude-opus-5-5");
    expect(c.ALLOW_LOCAL_SITES).toBe(false);
    expect(c.AI_STUB).toBe(false);
    expect(c.CORS_ALLOWED_ORIGINS).toEqual([]);
  });

  it("parses CORS origins list", () => {
    const c = loadConfig({ ...valid, CORS_ALLOWED_ORIGINS: "https://a.test, https://b.test" });
    expect(c.CORS_ALLOWED_ORIGINS).toEqual(["https://a.test", "https://b.test"]);
  });

  it("throws when ALLOW_LOCAL_SITES=true in production", () => {
    expect(() => loadConfig({ ...valid, NODE_ENV: "production", ALLOW_LOCAL_SITES: "true" })).toThrow();
    expect(loadConfig({ ...valid, ALLOW_LOCAL_SITES: "true" }).ALLOW_LOCAL_SITES).toBe(true);
  });

  it("throws without ANTHROPIC_API_KEY", () => {
    const { ANTHROPIC_API_KEY: _omit, ...rest } = valid;
    void _omit;
    expect(() => loadConfig(rest)).toThrow();
  });

  it("allows missing ANTHROPIC_API_KEY only with AI_STUB=true", () => {
    const { ANTHROPIC_API_KEY: _omit, ...rest } = valid;
    void _omit;
    expect(loadConfig({ ...rest, AI_STUB: "true" }).AI_STUB).toBe(true);
  });

  it("throws when AI_STUB=true in production", () => {
    expect(() => loadConfig({ ...valid, NODE_ENV: "production", AI_STUB: "true" })).toThrow();
  });

  it("throws when a required var is missing", () => {
    const { DATABASE_URL: _omit, ...rest } = valid;
    void _omit;
    expect(() => loadConfig(rest)).toThrow();
  });
});
