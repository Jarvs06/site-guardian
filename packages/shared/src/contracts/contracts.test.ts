import { describe, expect, it } from "vitest";
import {
  ChatRequest,
  ChatResponse,
  ConfigResponse,
  ErrorBody,
  RegisterCompleteRequest,
  RegisterCompleteResponse,
  RegisterStartRequest,
  RegisterStartResponse,
  RotateResponse,
  USER_REF_HEADER,
  UserRefHeader,
} from "../index.js";

const uuid = "123e4567-e89b-42d3-a456-426614174000";

describe("contracts", () => {
  it("ChatRequest is strict and bounded", () => {
    expect(ChatRequest.safeParse({ message: "hi", history: [] }).success).toBe(false);
    expect(ChatRequest.safeParse({ message: "" }).success).toBe(false);
    expect(ChatRequest.safeParse({ message: "x".repeat(4001) }).success).toBe(false);
    expect(ChatRequest.safeParse({ message: "x".repeat(4000) }).success).toBe(true);
    expect(ChatRequest.safeParse({ message: "hi", conversation_id: uuid }).success).toBe(true);
    expect(ChatRequest.safeParse({ message: "hi", conversation_id: "x" }).success).toBe(false);
  });
  it("RegisterStartRequest validates", () => {
    expect(RegisterStartRequest.safeParse({ installation_id: "x", site_url: "https://a.com" }).success).toBe(false);
    expect(RegisterStartRequest.safeParse({ installation_id: uuid, site_url: "https://a.com", wp_version: "6.4" }).success).toBe(true);
    expect(RegisterStartRequest.safeParse({ installation_id: uuid, site_url: "https://a.com", extra: 1 }).success).toBe(false);
    expect(RegisterStartRequest.safeParse({ installation_id: uuid, site_url: "https://a.com", wp_version: "x".repeat(33) }).success).toBe(false);
    expect(RegisterStartRequest.safeParse({ installation_id: uuid, site_url: "not-a-url" }).success).toBe(false);
  });
  it("other schemas parse valid data and reject extras", () => {
    const iso = new Date().toISOString();
    expect(RegisterStartResponse.safeParse({ challenge_id: uuid, challenge: "c", expires_at: iso }).success).toBe(true);
    expect(RegisterStartResponse.safeParse({ challenge_id: uuid, challenge: "c", expires_at: "soon" }).success).toBe(false);
    expect(RegisterCompleteRequest.safeParse({ challenge_id: uuid }).success).toBe(true);
    expect(RegisterCompleteRequest.safeParse({ challenge_id: uuid, x: 1 }).success).toBe(false);
    expect(RegisterCompleteResponse.safeParse({ website_id: uuid, credential: "sgat_x", plan_code: "free" }).success).toBe(true);
    expect(RotateResponse.safeParse({ credential: "sgat_x" }).success).toBe(true);
    expect(ConfigResponse.safeParse({ config: { a: 1 }, website: { id: uuid, status: "active" } }).success).toBe(true);
    expect(ChatResponse.safeParse({ reply: "ok", conversation_id: uuid }).success).toBe(true);
  });
  it("ErrorBody and user ref header", () => {
    expect(ErrorBody.safeParse({ error: { code: "not_found", message: "m" }, request_id: "r" }).success).toBe(true);
    expect(ErrorBody.safeParse({ error: { code: "nope", message: "m" }, request_id: "r" }).success).toBe(false);
    expect(USER_REF_HEADER).toBe("x-sg-user-ref");
    expect(UserRefHeader.safeParse("a".repeat(64)).success).toBe(true);
    expect(UserRefHeader.safeParse("A".repeat(64)).success).toBe(false);
    expect(UserRefHeader.safeParse("a".repeat(63)).success).toBe(false);
  });
});
