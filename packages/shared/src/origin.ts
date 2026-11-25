export class InvalidOriginError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidOriginError";
  }
}

export interface NormalizeOriginOptions {
  /** Allow IPv4 dotted or IPv6 bracketed hosts (non-production only). */
  allowIpHosts?: boolean;
}

const IPV4 = /^\d{1,3}(\.\d{1,3}){3}$/;

export function normalizeOrigin(url: string, options: NormalizeOriginOptions = {}): string {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new InvalidOriginError("Invalid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new InvalidOriginError("Only http and https URLs are allowed");
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw new InvalidOriginError("Credentials in URL are not allowed");
  }
  let host = parsed.hostname;
  if (host.endsWith(".")) host = host.slice(0, -1);
  if (host === "") {
    throw new InvalidOriginError("URL has an empty host");
  }
  const isIp = host.startsWith("[") || IPV4.test(host);
  if (isIp && options.allowIpHosts !== true) {
    throw new InvalidOriginError("IP-literal hosts are not allowed");
  }
  // URL.port is already empty for the scheme's default port.
  return `${parsed.protocol}//${host}${parsed.port === "" ? "" : `:${parsed.port}`}`;
}
