import type { ErrorRequestHandler, RequestHandler } from "express";
import type { ErrorBody } from "@sg/shared";
import { ApiError } from "../lib/errors.js";

function body(req: { id: unknown }, code: ErrorBody["error"]["code"], message: string): ErrorBody {
  return { error: { code, message }, request_id: String(req.id) };
}

export const notFoundHandler: RequestHandler = (req, res) => {
  res.status(404).json(body(req, "not_found", "Unknown endpoint."));
};

/** Never leaks stacks, internal URLs or DB errors: only a stable code and a safe message. */
export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, next) => {
  if (res.headersSent) {
    next(err);
    return;
  }
  if (err instanceof ApiError) {
    if (err.status >= 500) req.log?.error({ err }, err.message);
    for (const [k, v] of Object.entries(err.headers)) res.setHeader(k, v);
    res.status(err.status).json(body(req, err.code, err.message));
    return;
  }
  const type = (err as { type?: string } | null)?.type;
  if (type === "entity.too.large") {
    res.status(413).json(body(req, "bad_request", "Request body too large."));
    return;
  }
  if (type === "entity.parse.failed" || type === "encoding.unsupported" || type === "charset.unsupported") {
    res.status(400).json(body(req, "bad_request", "Malformed request body."));
    return;
  }
  req.log?.error({ err }, "Unhandled error");
  res.status(500).json(body(req, "internal", "Something went wrong. Please try again."));
};
