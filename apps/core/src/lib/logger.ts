import { pino, type DestinationStream, type Logger } from "pino";

const SENSITIVE = ["credential", "token", "challenge", "authorization", "cookie"];

export const REDACT_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
  ...SENSITIVE.flatMap((k) => [k, `*.${k}`]),
];

export type { Logger };

export function createLogger(level = "info", destination?: DestinationStream): Logger {
  return pino({ level, redact: { paths: REDACT_PATHS, censor: "[redacted]" } }, destination);
}
