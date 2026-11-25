import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import request from "supertest";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { SafeFetchError, USER_REF_HEADER } from "@sg/shared";
import type Anthropic from "@anthropic-ai/sdk";
import { createApp } from "../app.js";
import type { Config } from "../config.js";
import type { AiClient } from "../lib/ai.js";
import { ApiError } from "../lib/errors.js";
import { generateCredential } from "../lib/credential.js";
import { createSupabase } from "../lib/supabase.js";

const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
const supabase = createSupabase(process.env.SUPABASE_URL!, process.env.SUPABASE_SERVICE_ROLE_KEY!);
const siteIds: string[] = [];

afterAll(async () => {
  await pool.query("delete from rate_limits where split_part(key, ':', 1) = any($1)", [siteIds]);
  await pool.query("delete from websites where id = any($1)", [siteIds]); // cascades conversations/messages
  await pool.end();
});

const config: Config = {
  SUPABASE_URL: process.env.SUPABASE_URL!,
  SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY!,
  DATABASE_URL: process.env.DATABASE_URL!,
  ANTHROPIC_API_KEY: "unused",
  CORE_PUBLIC_URL: "http://localhost:8787",
  PORT: 8787,
  ANTHROPIC_MODEL: "claude-opus-5-5",
  ALLOW_LOCAL_SITES: false,
  AI_STUB: false,
  TRUST_PROXY: 0,
  CORS_ALLOWED_ORIGINS: [],
  NODE_ENV: "test",
  LOG_LEVEL: "silent",
};

interface Call {
  system: string;
  messages: Anthropic.MessageParam[];
}
function stubAi(impl?: (c: Call) => Promise<string>) {
  const calls: Call[] = [];
  const ai: AiClient = {
    reply: (c) => {
      calls.push({ system: c.system, messages: c.messages });
      return impl ? impl(c) : Promise.resolve(`reply ${calls.length}`);
    },
  };
  return { ai, calls };
}
function build(ai: AiClient) {
  return createApp({
    config,
    supabase,
    pool,
    ai,
    fetcher: () => Promise.reject(new SafeFetchError("network_error", "x")),
    queue: { enqueueLinkScan: () => Promise.reject(new Error("unused")), stop: () => Promise.resolve() },
  });
}

async function newSite() {
  const origin = `https://chat-${randomUUID()}.example.com`;
  const cred = generateCredential();
  const { rows } = await pool.query<{ id: string }>(
    `insert into websites (installation_id, origin, plan_id, site_url, site_name, credential_hash, credential_prefix)
     values ($1, $2, (select id from plans limit 1), $2, 'My Shop', $3, $4) returning id`,
    [randomUUID(), origin, cred.hash, cred.token.slice(0, 12)],
  );
  const id = rows[0]!.id;
  siteIds.push(id);
  return { id, origin, token: cred.token };
}

type S = Awaited<ReturnType<typeof newSite>>;
const chat = (app: ReturnType<typeof build>, s: S, body: unknown, userRef: string | null = "u1") => {
  const r = request(app).post("/api/v1/ai/chat").set("Authorization", `Bearer ${s.token}`);
  if (userRef !== null) r.set(USER_REF_HEADER, userRef);
  return r.send(body as object);
};

// A valid x-sg-user-ref is 64 hex chars.
const other = (r: string) => (r[0] === "a" ? "b" : "a") + r.slice(1);
let ref = "";
beforeEach(() => {
  ref = randomBytes(32).toString("hex");
});

describe("POST /ai/chat", () => {
  it("creates a conversation scoped to website + user ref", async () => {
    const s = await newSite();
    const { ai, calls } = stubAi();
    const res = await chat(build(ai), s, { message: "Hello" }, ref);
    expect(res.status).toBe(200);
    expect(res.body.reply).toBe("reply 1");
    const { rows } = await pool.query("select website_id, wp_user_ref from ai_conversations where id = $1", [res.body.conversation_id]);
    expect(rows[0]).toEqual({ website_id: s.id, wp_user_ref: ref });
    const msgs = await pool.query("select role, content from ai_messages where conversation_id = $1 order by created_at, role desc", [res.body.conversation_id]);
    expect(msgs.rows).toEqual([
      { role: "user", content: "Hello" },
      { role: "assistant", content: "reply 1" },
    ]);
    expect(calls[0]!.messages).toEqual([{ role: "user", content: "Hello" }]);
  });

  it("system prompt contains site name, origin and the coming-soon rule", async () => {
    const s = await newSite();
    const { ai, calls } = stubAi();
    await chat(build(ai), s, { message: "hi" }, ref);
    expect(calls[0]!.system).toContain(s.origin);
    expect(calls[0]!.system).toContain("My Shop");
    expect(calls[0]!.system).toContain("this check is coming soon");
  });

  it("feeds prior turns from the DB in order, capped at the last 20", async () => {
    const s = await newSite();
    const { ai, calls } = stubAi();
    const app = build(ai);
    const first = await chat(app, s, { message: "m0" }, ref);
    const cid = first.body.conversation_id as string;
    const t0 = Date.now() - 100_000;
    await pool.query("update ai_messages set created_at = $2 where conversation_id = $1", [cid, new Date(t0 - 10_000)]);
    for (let i = 1; i <= 12; i++) {
      await pool.query(
        "insert into ai_messages (conversation_id, role, content, created_at) values ($1,'user',$2,$3),($1,'assistant',$4,$5)",
        [cid, `m${i}`, new Date(t0 + i * 1000), `a${i}`, new Date(t0 + i * 1000 + 1)],
      );
    }
    const res = await chat(app, s, { message: "final", conversation_id: cid }, ref);
    expect(res.body.conversation_id).toBe(cid);
    const sent = calls[1]!.messages;
    expect(sent).toHaveLength(21);
    expect(sent.at(-1)).toEqual({ role: "user", content: "final" });
    expect(sent[0]).toEqual({ role: "user", content: "m3" });
    expect(sent[19]).toEqual({ role: "assistant", content: "a12" });
  });

  it("starts a new conversation for another website's or another user's id", async () => {
    const a = await newSite();
    const b = await newSite();
    const { ai, calls } = stubAi();
    const app = build(ai);
    const first = await chat(app, a, { message: "secret" }, ref);
    const cid = first.body.conversation_id as string;

    const otherSite = await chat(app, b, { message: "x", conversation_id: cid }, ref);
    expect(otherSite.status).toBe(200);
    expect(otherSite.body.conversation_id).not.toBe(cid);
    const otherUser = await chat(app, a, { message: "y", conversation_id: cid }, other(ref));
    expect(otherUser.status).toBe(200);
    expect(otherUser.body.conversation_id).not.toBe(cid);
    expect(calls[1]!.messages).toEqual([{ role: "user", content: "x" }]);
    expect(calls[2]!.messages).toEqual([{ role: "user", content: "y" }]);
  });

  it("rejects unknown fields such as history with 400", async () => {
    const s = await newSite();
    const res = await chat(build(stubAi().ai), s, { message: "hi", history: [] }, ref);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("bad_request");
  });

  it("requires the user-ref header", async () => {
    const s = await newSite();
    const res = await chat(build(stubAi().ai), s, { message: "hi" }, null);
    expect(res.status).toBe(400);
    expect(res.body.error.code).toBe("bad_request");
  });

  it("returns 502 ai_unavailable and still stores the user message", async () => {
    const s = await newSite();
    const { ai } = stubAi(() => Promise.reject(ApiError.aiUnavailable()));
    const res = await chat(build(ai), s, { message: "keep me" }, ref);
    expect(res.status).toBe(502);
    expect(res.body.error).toEqual({
      code: "ai_unavailable",
      message: "I'm having trouble answering right now. Please try again in a moment.",
    });
    const { rows } = await pool.query(
      `select m.role, m.content from ai_messages m join ai_conversations c on c.id = m.conversation_id
        where c.website_id = $1 and c.wp_user_ref = $2`,
      [s.id, ref],
    );
    expect(rows).toEqual([{ role: "user", content: "keep me" }]);
  });

  it("limits to 20 per minute per website+user", async () => {
    const s = await newSite();
    const app = build(stubAi().ai);
    for (let i = 0; i < 20; i++) expect((await chat(app, s, { message: "x" }, ref)).status).toBe(200);
    const res = await chat(app, s, { message: "x" }, ref);
    expect(res.status).toBe(429);
    expect((await chat(app, s, { message: "x" }, other(ref))).status).toBe(200);
  });
});
