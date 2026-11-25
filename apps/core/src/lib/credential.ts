import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

export const CREDENTIAL_PREFIX = "sgat_";
export const CREDENTIAL_PATTERN = /^sgat_[0-9a-f]{64}$/;
/** Leading characters of a credential kept in plaintext for display ("sgat_" + 7 hex). */
export const DISPLAY_PREFIX_LENGTH = 12;

/** SHA-256 hex digest. Credentials and challenges are only ever stored as this hash. */
export function hashToken(token: string): string {
  return createHash("sha256").update(token, "utf8").digest("hex");
}

/** A new site credential: `sgat_` + 32 random bytes as hex, plus its hash. */
export function generateCredential(): { token: string; hash: string } {
  const token = CREDENTIAL_PREFIX + randomBytes(32).toString("hex");
  return { token, hash: hashToken(token) };
}

/** A new registration challenge: 32 random bytes, base64url, plus its hash. */
export function generateChallenge(): { value: string; hash: string } {
  const value = randomBytes(32).toString("base64url");
  return { value, hash: hashToken(value) };
}

/** Constant-time check that `candidate` hashes to `storedHash`. */
export function hashMatches(candidate: string, storedHash: string): boolean {
  const a = Buffer.from(hashToken(candidate), "hex");
  const b = Buffer.from(storedHash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
