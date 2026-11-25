import { randomUUID } from "node:crypto";
import type { RequestHandler } from "express";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const requestId: RequestHandler = (req, res, next) => {
  const incoming = req.headers["x-request-id"];
  const id = typeof incoming === "string" && UUID.test(incoming) ? incoming.toLowerCase() : randomUUID();
  req.id = id;
  res.setHeader("x-request-id", id);
  next();
};
