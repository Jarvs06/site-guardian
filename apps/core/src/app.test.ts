import express from "express";
import request from "supertest";
import { describe, expect, it } from "vitest";
import { ErrorBody, safeFetch } from "@sg/shared";
import type { SupabaseClient } from "@supabase/supabase-js";
import pg from "pg";
import { createApp } from "./app.js";
import type { Config } from "./config.js";
import { ApiError } from "./lib/errors.js";

const config: Config = {
  SUPABASE_URL: "http://x",
  SUPABASE_SERVICE_ROLE_KEY: "k",
  DATABASE_URL: "postgres://x",
  ANTHROPIC_API_KEY: "k",
  CORE_PUBLIC_URL: "http://localhost",
  PORT: 8787,
  ANTHROPIC_MODEL: "claude-opus-5-5",
  ALLOW_LOCAL_SITES: false,
  AI_STUB: false,
  TRUST_PROXY: 0,
  CORS_ALLOWED_ORIGINS: ["https://allowed.test"],
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
};

function build(extra?: (app: express.Express) => void, overrides: Partial<Config> = {}) {
  return createApp({
    config: { ...config, ...overrides },
    supabase: {} as SupabaseClient,
    // Never connected: routers only need a real Pool instance at construction time.
    pool: new pg.Pool({ connectionString: "postgres://unused@127.0.0.1:1/none" }),
    ai: { reply: () => Promise.reject(new Error("unused")) },
    fetcher: safeFetch,
    extraRoutes: extra,
  });
}

describe("app skeleton", () => {
  it("GET /api/v1/health", async () => {
    const res = await request(build()).get("/api/v1/health");
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ status: "ok" });
  });

  it("unknown route -> 404 ErrorBody with x-request-id", async () => {
    const res = await request(build()).get("/nope");
    expect(res.status).toBe(404);
    expect(ErrorBody.safeParse(res.body).success).toBe(true);
    expect(res.headers["x-request-id"]).toBeTruthy();
    expect(res.body.request_id).toBe(res.headers["x-request-id"]);
  });

  it("echoes a UUID x-request-id and replaces a non-UUID one", async () => {
    const id = "3f2b8c1e-5b1a-4e0e-9a43-0d2f7c1a9b11";
    const a = await request(build()).get("/api/v1/health").set("x-request-id", id);
    expect(a.headers["x-request-id"]).toBe(id);
    const b = await request(build()).get("/api/v1/health").set("x-request-id", "not-a-uuid");
    expect(b.headers["x-request-id"]).not.toBe("not-a-uuid");
    expect(b.headers["x-request-id"]).toMatch(/^[0-9a-f-]{36}$/);
  });

  it("non-ApiError -> 500 internal without stack", async () => {
    const app = build((a) =>
      a.get("/api/v1/boom", () => {
        throw new Error("secret detail");
      }),
    );
    const res = await request(app).get("/api/v1/boom");
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("internal");
    expect(ErrorBody.safeParse(res.body).success).toBe(true);
    expect(JSON.stringify(res.body)).not.toMatch(/secret detail|stack|at /);
  });

  it("ApiError maps to its status and code", async () => {
    const app = build((a) =>
      a.get("/api/v1/nf", () => {
        throw ApiError.forbidden("no");
      }),
    );
    const res = await request(app).get("/api/v1/nf");
    expect(res.status).toBe(403);
    expect(res.body.error).toEqual({ code: "forbidden", message: "no" });
  });

  it("no x-powered-by", async () => {
    const res = await request(build()).get("/api/v1/health");
    expect(res.headers["x-powered-by"]).toBeUndefined();
  });

  it("JSON body over 256 KB -> 413 ErrorBody", async () => {
    const app = build((a) => a.post("/api/v1/echo", (_req, res) => res.json({ ok: true })));
    const res = await request(app)
      .post("/api/v1/echo")
      .set("content-type", "application/json")
      .send(JSON.stringify({ x: "a".repeat(300 * 1024) }));
    expect(res.status).toBe(413);
    expect(ErrorBody.safeParse(res.body).success).toBe(true);
    expect(res.body.error.message).toMatch(/too large/i);
  });

  it("malformed JSON -> 400 ErrorBody", async () => {
    const app = build((a) => a.post("/api/v1/echo", (_req, res) => res.json({ ok: true })));
    const res = await request(app).post("/api/v1/echo").set("content-type", "application/json").send("{bad");
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("bad_request");
    expect(ErrorBody.safeParse(res.body).success).toBe(true);
  });

  it("CORS is closed for unlisted origins and open for listed ones", async () => {
    const evil = await request(build()).get("/api/v1/health").set("Origin", "https://evil.test");
    expect(evil.headers["access-control-allow-origin"]).toBeUndefined();
    const ok = await request(build()).get("/api/v1/health").set("Origin", "https://allowed.test");
    expect(ok.headers["access-control-allow-origin"]).toBe("https://allowed.test");
  });

  it("trust proxy: ignores X-Forwarded-For at 0 hops, honours it at 1", async () => {
    const echo = (a: express.Express) => a.get("/api/v1/ip", (req, res) => res.json({ ip: req.ip }));
    const direct = await request(build(echo, { TRUST_PROXY: 0 })).get("/api/v1/ip").set("X-Forwarded-For", "1.2.3.4");
    expect(direct.body.ip).not.toBe("1.2.3.4");
    const proxied = await request(build(echo, { TRUST_PROXY: 1 })).get("/api/v1/ip").set("X-Forwarded-For", "1.2.3.4");
    expect(proxied.body.ip).toBe("1.2.3.4");
  });
});
