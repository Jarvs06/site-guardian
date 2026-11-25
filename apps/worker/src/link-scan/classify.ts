import { type LinkStatus, normalizeLinkUrl, SafeFetchError } from "@sg/shared";

export type Classification = { status: LinkStatus; httpCode: number; detail: string | null };
export type ErrorClassification = { status: LinkStatus; httpCode: null; detail: string };

/** Equal after normalizing, ignoring an http->https change and a trailing-slash difference. */
function sameUrl(a: string, b: string): boolean {
  const key = (raw: string): string => {
    const n = normalizeLinkUrl(raw, raw);
    const url = new URL(n.ok ? n.url : raw);
    const path = url.pathname.replace(/\/+$/, "");
    return `${url.host}${path}${url.search}`;
  };
  try {
    return key(a) === key(b);
  } catch {
    return a === b;
  }
}

export function classifyResponse(input: { requestedUrl: string; finalUrl: string; status: number }): Classification {
  const { status } = input;
  const done = (s: LinkStatus, detail: string | null): Classification => ({ status: s, httpCode: status, detail });
  if (status >= 200 && status < 300) {
    return sameUrl(input.requestedUrl, input.finalUrl)
      ? done("ok", null)
      : done("redirect", `Redirects to ${input.finalUrl}`);
  }
  if (status === 404) return done("broken", "Page not found (404)");
  if (status === 410) return done("broken", "Gone (410)");
  if (status === 401 || status === 403) return done("restricted", `Access restricted (${status})`);
  if (status === 429) return done("warning", "Rate limited (429)");
  if (status >= 400 && status < 500) return done("broken", `Client error (${status})`);
  if (status >= 500) return done("warning", `Server error (${status})`);
  return done("warning", `Unexpected response (${status})`);
}

const TLS_CODE = /^(ERR_TLS_|CERT_|DEPTH_ZERO_|UNABLE_TO_)/;

export function classifyError(err: SafeFetchError | Error): ErrorClassification {
  const out = (status: LinkStatus, detail: string): ErrorClassification => ({ status, httpCode: null, detail });
  if (!(err instanceof SafeFetchError)) return out("warning", "Connection failed");
  switch (err.code) {
    case "dns_failed":
      return out("broken", "Couldn't find this website (DNS)");
    case "timeout":
      return out("warning", "Timed out");
    case "too_many_redirects":
      return out("warning", "Too many redirects");
    case "blocked_address":
      return out("skipped", "Not checked: points to a private network address");
    case "bad_port":
      return out("skipped", "Not checked: port not allowed");
    case "invalid_url":
    case "bad_scheme":
      return out("skipped", "Invalid link");
    case "network_error": {
      const cause = (err.cause as { code?: unknown } | undefined)?.code;
      if (cause === "ECONNREFUSED") return out("broken", "Connection refused");
      if (typeof cause === "string" && TLS_CODE.test(cause)) return out("warning", "Secure connection failed");
      return out("warning", "Connection failed");
    }
  }
}
