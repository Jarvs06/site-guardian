import { Router } from "express";

export function healthRouter(): Router {
  const r = Router();
  r.get("/health", (_req, res) => {
    res.json({ status: "ok" });
  });
  return r;
}
