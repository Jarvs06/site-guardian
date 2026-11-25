import { normalizeLinkUrl, SCAN_LIMITS } from "@sg/shared";
import { Parser } from "htmlparser2";

export type ExtractedLink = { url: string; label: string | null };
export type SkippedLink = { href: string; reason: "scheme" | "invalid"; label: string | null };
export type ExtractedPage = {
  links: ExtractedLink[];
  skipped: SkippedLink[];
  robotsIndex: "index" | "noindex";
  robotsFollow: "follow" | "nofollow";
};

const LABEL_MAX = 200;
const ROBOTS_META_NAMES = new Set(["robots", "googlebot"]);
const DIRECTIVES = new Set(["noindex", "nofollow", "none", "index", "follow", "all"]);

type Directives = { noindex: boolean; nofollow: boolean };

function applyToken(token: string, out: Directives): void {
  if (token === "noindex") out.noindex = true;
  else if (token === "nofollow") out.nofollow = true;
  else if (token === "none") {
    out.noindex = true;
    out.nofollow = true;
  }
}

function parseMetaRobots(content: string, out: Directives): void {
  for (const raw of content.split(",")) applyToken(raw.trim().toLowerCase(), out);
}

/** Only directives not scoped to a named bot ("otherbot: noindex") count. */
function parseRobotsHeader(value: string, out: Directives): void {
  let botScoped = false;
  for (const raw of value.split(",")) {
    let token = raw.trim().toLowerCase();
    const colon = token.indexOf(":");
    if (colon !== -1) {
      const prefix = token.slice(0, colon).trim();
      if (!DIRECTIVES.has(prefix)) {
        botScoped = true;
        token = token.slice(colon + 1).trim();
      }
    }
    if (!botScoped) applyToken(token, out);
  }
}

function headerValue(headers: Record<string, string>, name: string): string | undefined {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === name) return value;
  }
  return undefined;
}

export function extractPage(html: string, finalUrl: string, headers: Record<string, string>): ExtractedPage {
  const links: ExtractedLink[] = [];
  const skipped: SkippedLink[] = [];
  const robots: Directives = { noindex: false, nofollow: false };
  let base = finalUrl;
  let baseSeen = false;
  let anchor: { href: string; text: string } | null = null;
  // A scan keeps at most maxLinks links, so one page never needs to give more; robots are still read.
  const full = (): boolean => links.length + skipped.length >= SCAN_LIMITS.maxLinks;

  const finishAnchor = (): void => {
    if (anchor === null) return;
    const { href, text } = anchor;
    anchor = null;
    const label = text.replace(/\s+/g, " ").trim().slice(0, LABEL_MAX) || null;
    if (href === "" || href.startsWith("#")) return;
    const result = normalizeLinkUrl(href, base);
    if (result.ok) links.push({ url: result.url, label });
    else skipped.push({ href, reason: result.reason, label });
  };

  const parser = new Parser(
    {
      onopentag(name, attrs) {
        if (name === "base") {
          if (!baseSeen && attrs.href !== undefined) {
            baseSeen = true;
            try {
              base = new URL(attrs.href.trim(), finalUrl).href;
            } catch {
              // an unusable base is ignored
            }
          }
        } else if (name === "meta") {
          const metaName = attrs.name?.trim().toLowerCase();
          if (metaName !== undefined && ROBOTS_META_NAMES.has(metaName) && attrs.content !== undefined) {
            parseMetaRobots(attrs.content, robots);
          }
        } else if (name === "a") {
          finishAnchor();
          if (attrs.href !== undefined && !full()) anchor = { href: attrs.href.trim(), text: "" };
        }
      },
      ontext(text) {
        if (anchor !== null && anchor.text.length < LABEL_MAX * 4) anchor.text += text;
      },
      onclosetag(name) {
        if (name === "a") finishAnchor();
      },
    },
    { decodeEntities: true },
  );
  parser.write(html);
  parser.end();
  finishAnchor();

  const header = headerValue(headers, "x-robots-tag");
  if (header !== undefined) parseRobotsHeader(header, robots);

  return {
    links,
    skipped,
    robotsIndex: robots.noindex ? "noindex" : "index",
    robotsFollow: robots.nofollow ? "nofollow" : "follow",
  };
}
