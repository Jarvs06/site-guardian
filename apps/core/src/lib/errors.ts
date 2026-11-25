import type { ErrorCode } from "@sg/shared";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: ErrorCode,
    message: string,
    readonly headers: Record<string, string> = {},
  ) {
    super(message);
    this.name = "ApiError";
  }

  static badRequest(message = "Bad request.") {
    return new ApiError(400, "bad_request", message);
  }
  static unauthorized(message = "Unauthorized.") {
    return new ApiError(401, "unauthorized", message);
  }
  static forbidden(message = "Forbidden.") {
    return new ApiError(403, "forbidden", message);
  }
  static notFound(message = "Not found.") {
    return new ApiError(404, "not_found", message);
  }
  static conflict(message = "Conflict.") {
    return new ApiError(409, "conflict", message);
  }
  static rateLimited(retryAfterSec = 60, message = "Too many requests. Please try again later.") {
    return new ApiError(429, "rate_limited", message, { "Retry-After": String(Math.max(1, Math.ceil(retryAfterSec))) });
  }
  static verificationFailed(message = "Verification failed.") {
    return new ApiError(400, "verification_failed", message);
  }
  static aiUnavailable(message = "I'm having trouble answering right now. Please try again in a moment.") {
    return new ApiError(502, "ai_unavailable", message);
  }
  static internal(message = "Something went wrong. Please try again.") {
    return new ApiError(500, "internal", message);
  }
}
