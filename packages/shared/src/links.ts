import { normalizeOrigin } from "./origin.js";

export const TRACKING_PARAMS: readonly string[] = [
  "dt", "utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content", "utm_id",
  "fbclid", "gclid", "gad_source", "gbraid", "wbraid", "mc_eid", "_ga", "_gl", "ref",
  "source", "affiliate", "partner", "msclkid", "twclid", "li_fat_id", "igshid", "igsh",
];

export type NormalizedLink = { ok: true; url: string } | { ok: false; reason: "invalid" | "scheme" };

function paramName(pair: string): string {
  const raw = pair.split("=", 1)[0] ?? "";
  try {
    return decodeURIComponent(raw.replace(/\+/g, " "));
  } catch {
    return raw;
  }
}

export function normalizeLinkUrl(href: string, base: string): NormalizedLink {
  const trimmed = href.trim();
  if (trimmed === "" || trimmed === "#") return { ok: false, reason: "invalid" };
  let parsed: URL;
  try {
    parsed = new URL(trimmed, base);
  } catch {
    return { ok: false, reason: "invalid" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { ok: false, reason: "scheme" };
  }
  parsed.hash = "";
  if (parsed.search !== "") {
    const kept = parsed.search
      .slice(1)
      .split("&")
      .filter((pair) => pair !== "" && !TRACKING_PARAMS.includes(paramName(pair)));
    parsed.search = kept.length > 0 ? `?${kept.join("&")}` : "";
  }
  return { ok: true, url: parsed.href };
}

/**
 * True when url's normalized origin equals origin. IP hosts are allowed on both sides: a production
 * origin is never an IP literal, so this only matters for local sites registered at an IP.
 */
export function sameOrigin(url: string, origin: string): boolean {
  try {
    return normalizeOrigin(url, { allowIpHosts: true }) === normalizeOrigin(origin, { allowIpHosts: true });
  } catch {
    return false;
  }
}

export function isWpClutter(url: string, origin: string): boolean {
  if (!sameOrigin(url, origin)) return false;
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.searchParams.has("replytocom") || parsed.searchParams.has("share")) return true;
  const path = parsed.pathname;
  return (
    path.endsWith("/feed") ||
    path.endsWith("/feed/") ||
    path === "/wp-login.php" ||
    path.startsWith("/wp-admin/") ||
    path === "/xmlrpc.php" ||
    path.startsWith("/wp-json/")
  );
}
