import { randomUUID } from "node:crypto";
import express from "express";
import pg from "pg";
import request from "supertest";
import { afterAll, describe, expect, it } from "vitest";
import { errorHandler } from "../middleware/error-handler.js";
import { requestId } from "../middleware/request-id.js";
import { limiter } from "./rate-limit.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
afterAll(() => pool.end());

function appWith(p: pg.Pool, name: string) {
  const app = express();
  app.use(requestId);
  app.get("/x", limiter(p, name, { points: 3, durationSec: 60 }, () => "k1"), (_req, res) => {
    res.json({ ok: true });
  });
  app.use(errorHandler);
  return app;
}

describe("limiter (real Postgres)", () => {
  it("allows N requests then returns 429 with Retry-After", async () => {
    const app = appWith(pool, `test-${randomUUID()}`);
    for (let i = 0; i < 3; i++) expect((await request(app).get("/x")).status).toBe(200);
    const res = await request(app).get("/x");
    expect(res.status).toBe(429);
    expect(res.body.error.code).toBe("rate_limited");
    expect(Number(res.headers["retry-after"])).toBeGreaterThan(0);
  });

  it("fails closed with 500 internal when the store errors", async () => {
    const broken = new pg.Pool({ connectionString: "postgres://nobody:x@127.0.0.1:1/none" });
    const res = await request(appWith(broken, `test-${randomUUID()}`)).get("/x");
    await broken.end();
    expect(res.status).toBe(500);
    expect(res.body.error.code).toBe("internal");
  });
});
