import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { generateChallenge, generateCredential, hashMatches, hashToken } from "./credential.js";

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

describe("credential helpers", () => {
  it("generateCredential returns sgat_ + 64 hex and its SHA-256 hash", () => {
    const { token, hash } = generateCredential();
    expect(token).toMatch(/^sgat_[0-9a-f]{64}$/);
    expect(hash).toBe(sha256(token));
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("generateCredential is random", () => {
    expect(generateCredential().token).not.toBe(generateCredential().token);
  });

  it("hashToken is SHA-256 hex", () => {
    expect(hashToken("abc")).toBe(sha256("abc"));
  });

  it("generateChallenge returns a random URL-safe value and its hash", () => {
    const a = generateChallenge();
    const b = generateChallenge();
    expect(a.value).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(a.hash).toBe(sha256(a.value));
    expect(a.value).not.toBe(b.value);
  });

  it("hashMatches compares a candidate value against a stored hash", () => {
    const { value, hash } = generateChallenge();
    expect(hashMatches(value, hash)).toBe(true);
    expect(hashMatches(`${value}x`, hash)).toBe(false);
    expect(hashMatches(value, "not-a-hash")).toBe(false);
  });
});
