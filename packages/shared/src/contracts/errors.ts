import { z } from "zod";

export const ERROR_CODES = [
  "bad_request",
  "unauthorized",
  "forbidden",
  "not_found",
  "rate_limited",
  "verification_failed",
  "ai_unavailable",
  "internal",
] as const;

export const ErrorCode = z.enum(ERROR_CODES);
export type ErrorCode = z.infer<typeof ErrorCode>;

export const ErrorBody = z
  .object({
    error: z.object({ code: ErrorCode, message: z.string() }).strict(),
    request_id: z.string(),
  })
  .strict();
export type ErrorBody = z.infer<typeof ErrorBody>;

export const USER_REF_HEADER = "x-sg-user-ref";
export const UserRefHeader = z.string().regex(/^[0-9a-f]{64}$/);
export type UserRefHeader = z.infer<typeof UserRefHeader>;
