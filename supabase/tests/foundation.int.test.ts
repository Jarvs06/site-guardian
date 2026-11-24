import { randomUUID } from "node:crypto";
import { createClient } from "@supabase/supabase-js";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const url = process.env.SUPABASE_URL as string;
const anon = createClient(url, process.env.SUPABASE_ANON_KEY as string, { auth: { persistSession: false } });
const service = createClient(url, process.env.SUPABASE_SERVICE_ROLE_KEY as string, { auth: { persistSession: false } });
const db = new pg.Client({ connectionString: process.env.DATABASE_URL });

const TABLES = [
  "users", "plans", "websites", "registration_challenges", "subscriptions", "credit_balances",
  "credit_transactions", "ai_conversations", "ai_messages", "scan_jobs", "remote_config",
  "audit_logs", "rate_limits",
];

async function freePlanId(): Promise<string> {
  const { data, error } = await service.from("plans").select("id").eq("code", "free").single();
  expect(error).toBeNull();
  return (data as { id: string }).id;
}

function websiteRow(planId: string, origin: string) {
  return {
    installation_id: randomUUID(), plan_id: planId, site_url: origin, origin,
    credential_hash: "h", credential_prefix: "sgat_abc",
  };
}

beforeAll(async () => { await db.connect(); });
afterAll(async () => { await db.end(); });

describe("foundation schema", () => {
  it("has RLS enabled on every public table and no policies", async () => {
    const t = await db.query("select relname, relrowsecurity from pg_class c join pg_namespace n on n.oid=c.relnamespace where n.nspname='public' and c.relkind='r'");
    expect(t.rows.length).toBeGreaterThanOrEqual(TABLES.length);
    for (const r of t.rows) expect(r.relrowsecurity, r.relname).toBe(true);
    const names = t.rows.map((r) => r.relname);
    for (const name of TABLES) expect(names).toContain(name);
    const p = await db.query("select count(*)::int as n from pg_policies where schemaname='public'");
    expect(p.rows[0].n).toBe(0);
  });

  it.each(TABLES)("anon cannot read %s", async (table) => {
    const { data, error } = await anon.from(table).select("*").limit(1);
    expect(error !== null || (data ?? []).length === 0).toBe(true);
  });

  it("anon cannot insert into websites", async () => {
    const planId = await freePlanId();
    const { error } = await anon.from("websites").insert(websiteRow(planId, "https://anon.example"));
    expect(error).not.toBeNull();
  });

  it("anon cannot call sg_apply_credit_transaction", async () => {
    const { error } = await anon.rpc("sg_apply_credit_transaction", {
      p_website_id: randomUUID(), p_type: "grant", p_amount: 1, p_description: "x", p_idempotency_key: randomUUID(),
    });
    expect(error).not.toBeNull();
  });

  it("seeds the four plans", async () => {
    const { data } = await service.from("plans").select("code").order("code");
    expect((data ?? []).map((r) => r.code)).toEqual(["enterprise", "free", "pro", "starter"]);
  });

  it("rejects duplicate origin but allows a shared installation_id", async () => {
    const planId = await freePlanId();
    const origin = `https://${randomUUID()}.example`;
    const first = websiteRow(planId, origin);
    expect((await service.from("websites").insert(first)).error).toBeNull();
    expect((await service.from("websites").insert(websiteRow(planId, origin))).error).not.toBeNull();
    const sameInstall = { ...websiteRow(planId, `https://${randomUUID()}.example`), installation_id: first.installation_id };
    expect((await service.from("websites").insert(sameInstall)).error).toBeNull();
  });

  it("credit transactions apply atomically and never go negative", async () => {
    const planId = await freePlanId();
    const { data: site } = await service.from("websites").insert(websiteRow(planId, `https://${randomUUID()}.example`)).select("id").single();
    const id = (site as { id: string }).id;
    const grant = await service.rpc("sg_apply_credit_transaction", {
      p_website_id: id, p_type: "grant", p_amount: 5, p_description: "g", p_idempotency_key: randomUUID(),
    });
    expect(grant.error).toBeNull();
    expect(grant.data).toMatchObject({ balance_before: 0, balance_after: 5 });
    const over = await service.rpc("sg_apply_credit_transaction", {
      p_website_id: id, p_type: "consume", p_amount: -6, p_description: "c", p_idempotency_key: randomUUID(),
    });
    expect(over.error?.message).toMatch(/Insufficient credit balance/);
    const { data: bal } = await service.from("credit_balances").select("balance").eq("website_id", id).single();
    expect(bal).toEqual({ balance: 5 });
  });

  it("idempotent replay (sequential and concurrent) applies once and returns the same row", async () => {
    const planId = await freePlanId();
    const { data: site } = await service.from("websites").insert(websiteRow(planId, `https://${randomUUID()}.example`)).select("id").single();
    const id = (site as { id: string }).id;
    const call = (key: string) => service.rpc("sg_apply_credit_transaction", {
      p_website_id: id, p_type: "grant", p_amount: 3, p_description: "g", p_idempotency_key: key,
    });
    const k1 = randomUUID();
    const a = await call(k1);
    const b = await call(k1);
    expect(a.error).toBeNull();
    expect(b.error).toBeNull();
    expect((b.data as { id: string }).id).toBe((a.data as { id: string }).id);

    const k2 = randomUUID();
    const results = await Promise.all(Array.from({ length: 4 }, () => call(k2)));
    for (const r of results) expect(r.error).toBeNull();
    expect(new Set(results.map((r) => (r.data as { id: string }).id)).size).toBe(1);

    const { data: bal } = await service.from("credit_balances").select("balance").eq("website_id", id).single();
    expect(bal).toEqual({ balance: 6 });
  });

  it("registration_challenges and rate_limits accept service-role writes", async () => {
    const ch = await service.from("registration_challenges").insert({
      installation_id: randomUUID(), origin: "https://c.example", site_url: "https://c.example",
      challenge_hash: "x", expires_at: new Date(Date.now() + 600_000).toISOString(),
    });
    expect(ch.error).toBeNull();
    const rl = await service.from("rate_limits").upsert({ key: `k-${randomUUID()}`, points: 1, expire: Date.now() + 1000 });
    expect(rl.error).toBeNull();
  });

  it("anon and authenticated lack execute on the credit function and table privileges", async () => {
    const r = await db.query(`select
      has_function_privilege('anon','sg_apply_credit_transaction(uuid,text,integer,text,text,uuid,uuid)','execute') as a,
      has_function_privilege('authenticated','sg_apply_credit_transaction(uuid,text,integer,text,text,uuid,uuid)','execute') as b,
      has_table_privilege('anon','public.websites','select') as c,
      has_table_privilege('authenticated','public.websites','select') as d`);
    expect(r.rows[0]).toEqual({ a: false, b: false, c: false, d: false });
  });
});
