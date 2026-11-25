import { lookup as dnsLookup } from "node:dns/promises";
import { isIP, type LookupFunction } from "node:net";
import { Agent, type Dispatcher, request } from "undici";
import { isBlockedAddress } from "./ip-policy.js";

export interface SafeFetchOptions {
  method?: "GET" | "HEAD";
  /** Default 5. */
  maxRedirects?: number;
  /** Total budget across DNS, connects and all redirect hops. Default 10000. */
  timeoutMs?: number;
  /** Body is cut off (truncated: true) beyond this many bytes. Default 1_048_576. */
  maxBytes?: number;
  /** Default [80, 443]. */
  allowedPorts?: number[];
  /** Skip only the IP-range check (local development). Default false. */
  allowPrivate?: boolean;
  /** Resolve a hostname to IP addresses. Default: OS resolver (all addresses). */
  resolver?: (host: string) => Promise<string[]>;
  headers?: Record<string, string>;
}

export interface SafeFetchResponse {
  status: number;
  finalUrl: string;
  headers: Record<string, string>;
  body: string;
  truncated: boolean;
}

export type SafeFetchErrorCode =
  | "blocked_address"
  | "bad_scheme"
  | "bad_port"
  | "too_many_redirects"
  | "timeout"
  | "dns_failed"
  /** Connection refused/reset, TLS or certificate failure, malformed response, etc. */
  | "network_error"
  /** Unparsable input URL or redirect Location. */
  | "invalid_url";

export class SafeFetchError extends Error {
  override readonly name = "SafeFetchError";
  constructor(
    readonly code: SafeFetchErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

type ResponseData = Dispatcher.ResponseData;

/** Per-attempt TCP/TLS connect limit, so one dead address leaves budget for the next. */
const CONNECT_TIMEOUT_MS = 3000;

/** Errors raised before any request byte is sent, where trying the next address is safe. */
const CONNECT_FAILURE_CODES = new Set([
  "ECONNREFUSED",
  "EHOSTUNREACH",
  "ENETUNREACH",
  "EADDRNOTAVAIL",
  "UND_ERR_CONNECT_TIMEOUT",
]);

const defaultResolver = async (host: string): Promise<string[]> =>
  (await dnsLookup(host, { all: true, verbatim: true })).map((a) => a.address);

/**
 * Fetch a user-supplied URL without allowing SSRF: http(s) only, allowed ports
 * only, every resolved address checked, each connect pinned to one validated
 * address (falling back to the next validated one only if the connect fails),
 * redirects followed manually with every check re-run per hop.
 */
export function safeFetch(url: string, opts: SafeFetchOptions = {}): Promise<SafeFetchResponse> {
  return safeFetchWithPolicy(url, opts, opts.allowPrivate ? () => false : isBlockedAddress);
}

/**
 * Internal: safeFetch with an explicit address policy. Exists so tests can reach
 * a loopback test server while every other address uses the real policy. Not
 * exported from the package.
 */
export async function safeFetchWithPolicy(
  url: string,
  opts: SafeFetchOptions,
  isBlocked: (ip: string) => boolean,
): Promise<SafeFetchResponse> {
  const controller = new AbortController();
  const timeoutMs = opts.timeoutMs ?? 10_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await run(url, opts, isBlocked, controller.signal);
  } catch (err) {
    if (err instanceof SafeFetchError) throw err;
    if (controller.signal.aborted) {
      throw new SafeFetchError("timeout", `request exceeded ${timeoutMs}ms`, { cause: err });
    }
    if (isTransportError(err)) {
      throw new SafeFetchError("network_error", err instanceof Error ? err.message : "network error", { cause: err });
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function run(
  url: string,
  opts: SafeFetchOptions,
  isBlocked: (ip: string) => boolean,
  signal: AbortSignal,
): Promise<SafeFetchResponse> {
  const method = opts.method ?? "GET";
  const maxRedirects = opts.maxRedirects ?? 5;
  const maxBytes = opts.maxBytes ?? 1_048_576;
  const allowedPorts = opts.allowedPorts ?? [80, 443];
  const resolver = opts.resolver ?? defaultResolver;

  // Cookies are never sent; Host is always derived from the URL (it also drives TLS SNI).
  const baseHeaders: Record<string, string> = {};
  for (const [name, value] of Object.entries(opts.headers ?? {})) {
    const lower = name.toLowerCase();
    if (lower !== "cookie" && lower !== "host") baseHeaders[lower] = value;
  }

  let current = parseUrl(url, "invalid URL");
  for (let redirects = 0; ; redirects++) {
    const hopHeaders = { ...baseHeaders };
    if (redirects > 0) delete hopHeaders.authorization;

    const ips = await validateHop(current, allowedPorts, resolver, isBlocked, signal);
    const target = `${current.protocol}//${current.host}${current.pathname}${current.search}`;
    let agent: Agent | undefined;
    // undici does not cancel an in-flight TCP/TLS connect on abort; destroying the agent does.
    const onAbort = () => void agent?.destroy().catch(() => {});
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      let res: ResponseData | undefined;
      // Try each checked address in order, each attempt pinned to that one address. Move on only
      // when the connect itself failed (no request byte sent) and the overall budget remains.
      for (const [i, ip] of ips.entries()) {
        agent = new Agent({ connect: { lookup: pinnedLookup(ip), timeout: CONNECT_TIMEOUT_MS } });
        try {
          res = await request(target, { dispatcher: agent, method, headers: hopHeaders, signal });
          break;
        } catch (err) {
          const tryNext = i < ips.length - 1 && !signal.aborted && isConnectFailure(err);
          if (!tryNext) throw err;
          await agent.destroy().catch(() => {});
        }
      }
      if (res === undefined) throw new Error("unreachable: validateHop returns at least one address");
      // Discarding a body early (redirect, truncation) destroys the stream; that is not an error.
      res.body.on("error", () => {});
      const location = firstHeader(res.headers.location);
      if (REDIRECT_STATUSES.has(res.statusCode) && location !== undefined) {
        res.body.destroy();
        if (redirects >= maxRedirects) {
          throw new SafeFetchError("too_many_redirects", `more than ${maxRedirects} redirects`);
        }
        current = parseUrl(location, "invalid redirect location", current);
        continue;
      }
      const { body, truncated } = await readBody(res.body, maxBytes);
      return { status: res.statusCode, finalUrl: target, headers: flattenHeaders(res.headers), body, truncated };
    } finally {
      signal.removeEventListener("abort", onAbort);
      await agent?.destroy().catch(() => {});
    }
  }
}

/**
 * Node system errors (ECONNREFUSED, ECONNRESET, ...), TLS/certificate errors and
 * undici errors all carry a string `code`. Caller misuse (UND_ERR_INVALID_ARG,
 * e.g. a forbidden header) and plain programming errors are rethrown as-is.
 */
function isTransportError(err: unknown): boolean {
  if (typeof err !== "object" || err === null || !("code" in err)) return false;
  return typeof err.code === "string" && err.code !== "UND_ERR_INVALID_ARG";
}

function isConnectFailure(err: unknown): boolean {
  const codeOf = (e: unknown): unknown =>
    typeof e === "object" && e !== null && "code" in e ? e.code : undefined;
  const cause = typeof err === "object" && err !== null && "cause" in err ? err.cause : undefined;
  return [codeOf(err), codeOf(cause)].some((code) => typeof code === "string" && CONNECT_FAILURE_CODES.has(code));
}

function parseUrl(input: string, what: string, base?: URL): URL {
  try {
    return new URL(input, base);
  } catch (err) {
    throw new SafeFetchError("invalid_url", what, { cause: err });
  }
}

/**
 * Run scheme, port, DNS and address checks for one hop; return every resolved IP, all checked, in
 * resolver order. Any blocked address rejects the whole request.
 */
async function validateHop(
  url: URL,
  allowedPorts: number[],
  resolver: (host: string) => Promise<string[]>,
  isBlocked: (ip: string) => boolean,
  signal: AbortSignal,
): Promise<string[]> {
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new SafeFetchError("bad_scheme", `scheme not allowed: ${url.protocol}`);
  }
  const port = url.port ? Number(url.port) : url.protocol === "https:" ? 443 : 80;
  if (!allowedPorts.includes(port)) throw new SafeFetchError("bad_port", `port not allowed: ${port}`);

  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  let ips: string[];
  if (isIP(host)) {
    ips = [host];
  } else {
    try {
      ips = await abortable(Promise.resolve().then(() => resolver(host)), signal);
    } catch (err) {
      if (err instanceof SafeFetchError) throw err;
      throw new SafeFetchError("dns_failed", `could not resolve ${host}`, { cause: err });
    }
    if (ips.length === 0) throw new SafeFetchError("dns_failed", `no addresses for ${host}`);
    if (!ips.every((ip) => isIP(ip))) throw new SafeFetchError("dns_failed", `invalid address for ${host}`);
  }
  // Refuse if ANY address is blocked rather than picking a "good" one.
  const blocked = ips.find((ip) => isBlocked(ip));
  if (blocked !== undefined) throw new SafeFetchError("blocked_address", `address not allowed for ${host}`);
  return ips;
}

function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new SafeFetchError("timeout", "request timed out"));
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** A DNS lookup that can only ever answer with the already-validated address. */
function pinnedLookup(ip: string): LookupFunction {
  const family = isIP(ip);
  return ((_hostname, options, callback) => {
    if (options.all) callback(null, [{ address: ip, family }]);
    else callback(null, ip, family);
  }) as LookupFunction;
}

async function readBody(body: AsyncIterable<Buffer>, maxBytes: number): Promise<{ body: string; truncated: boolean }> {
  const chunks: Buffer[] = [];
  let size = 0;
  let truncated = false;
  for await (const chunk of body) {
    if (size + chunk.length > maxBytes) {
      chunks.push(chunk.subarray(0, maxBytes - size));
      truncated = true;
      break; // ends iteration and destroys the stream
    }
    chunks.push(chunk);
    size += chunk.length;
  }
  return { body: new TextDecoder("utf-8").decode(Buffer.concat(chunks)), truncated };
}

function firstHeader(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

function flattenHeaders(headers: Record<string, string | string[] | undefined>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (value !== undefined) out[name] = Array.isArray(value) ? value.join(", ") : value;
  }
  return out;
}
