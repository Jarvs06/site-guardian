import {
  isWpClutter,
  type LinkStatus,
  normalizeLinkUrl,
  SafeFetchError,
  type safeFetch,
  type SafeFetchOptions,
  type SafeFetchResponse,
  SCAN_LIMITS,
  sameOrigin,
} from "@sg/shared";
import { classifyError, classifyResponse } from "./classify.js";
import { type ExtractedPage, extractPage } from "./html.js";
import { createKeyedLimiter, type KeyedLimiter } from "./limits.js";

/** A link_results row without `id` and `checked_at`. */
export type ResultRow = {
  kind: "page" | "link";
  url: string;
  label: string | null;
  source: string;
  found_in: string | null;
  found_count: number;
  status: LinkStatus;
  http_code: number | null;
  detail: string | null;
  robots_index: "index" | "noindex" | null;
  robots_follow: "follow" | "nofollow" | null;
};

export type ScanProgress = { pagesTotal: number; pagesChecked: number; linksTotal: number; linksChecked: number };

export interface ScanSink {
  alreadyChecked(): Promise<{ pages: Set<string>; links: Set<string> }>;
  writeResults(rows: ResultRow[]): Promise<void>;
  progress(p: ScanProgress): Promise<"continue" | "cancelled">;
}

export type LinkScanInput = {
  origin: string;
  pages: { url: string; source: string }[];
  allowLocal: boolean;
  userAgent: string;
  fetcher: typeof safeFetch;
  sink: ScanSink;
  now: () => number;
  deadlineAt: number;
  /** For tests: called after each page is merged, with the pages and link entries still held in memory. */
  onHeld?: (held: { pages: number; entries: number }) => void;
};

export type LinkScanResult = { outcome: "completed" | "cancelled"; truncated: "link_cap" | "time_limit" | null };

type Check = { status: LinkStatus; httpCode: number | null; detail: string | null };
type LinkEntry = { url: string; label: string | null; foundIn: string; foundCount: number; skipped: string | null };
/** A link taken from a page, ready to merge into the scan's links. */
type PageLink = { url: string; label: string | null; skipped: string | null };
type FetchResult = SafeFetchResponse | SafeFetchError | typeof STOPPED;

const STOPPED = Symbol("stopped");
const PAGE_REQUEST: SafeFetchOptions = { method: "GET", maxBytes: 2_097_152, timeoutMs: 15_000, maxRedirects: 5 };
const LINK_GET: SafeFetchOptions = { method: "GET", maxBytes: 65_536, timeoutMs: 10_000 };
const LINK_HEAD: SafeFetchOptions = { method: "HEAD", timeoutMs: 10_000 };
const ACCEPT = "text/html,application/xhtml+xml;q=0.9,*/*;q=0.8";
const ORIGIN_KEY = "origin";
const BATCH_SIZE = 100;
const PROGRESS_INTERVAL_MS = 1000;
const URL_MAX = 2048;
const DETAIL_MAX = 500;
const TOO_LARGE = "Page too large to read fully";
const INVALID = "Invalid link";
const NOT_WEB = "Not checked: not a web link";

function isHtml(headers: Record<string, string>): boolean {
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "content-type") return value.split(";")[0]?.trim().toLowerCase() === "text/html";
  }
  return false;
}

function pageKey(url: string): string {
  const n = normalizeLinkUrl(url, url);
  return n.ok ? n.url : url;
}

function classify(requestedUrl: string, r: SafeFetchResponse | SafeFetchError): Check {
  return r instanceof SafeFetchError
    ? classifyError(r)
    : classifyResponse({ requestedUrl, finalUrl: r.finalUrl, status: r.status });
}

/** HEAD answers that don't tell us anything, so the link is retried with GET. */
function headInconclusive(r: SafeFetchResponse | SafeFetchError): boolean {
  if (r instanceof SafeFetchError) return r.code === "network_error" || r.code === "timeout";
  return r.status === 405 || r.status === 501;
}

async function settleAll(tasks: Promise<unknown>[]): Promise<void> {
  const settled = await Promise.allSettled(tasks);
  const failed = settled.find((s) => s.status === "rejected");
  if (failed) throw failed.reason;
}

class LinkScan {
  private readonly originLimit: KeyedLimiter = createKeyedLimiter(4, 4);
  private readonly externalLimit: KeyedLimiter = createKeyedLimiter(2, 16);
  private readonly requestBase: SafeFetchOptions;
  private done: { pages: Set<string>; links: Set<string> } = { pages: new Set(), links: new Set() };
  private readonly pageChecks = new Map<string, Check>();
  private readonly links = new Map<string, LinkEntry>();
  private buffer: ResultRow[] = [];
  private writes: Promise<void> = Promise.resolve();
  private pendingProgress: Promise<void> | null = null;
  private lastProgressAt = -Infinity;
  private pagesChecked = 0;
  private linksChecked = 0;
  private cancelled = false;
  private timeUp = false;
  private linkCap = false;
  private failure: { error: unknown } | null = null;

  constructor(private readonly input: LinkScanInput) {
    const allowedPorts = [80, 443];
    const originPort = new URL(input.origin).port;
    if (input.allowLocal && originPort !== "" && !allowedPorts.includes(Number(originPort))) {
      allowedPorts.push(Number(originPort));
    }
    this.requestBase = {
      headers: { "User-Agent": input.userAgent, Accept: ACCEPT },
      allowPrivate: input.allowLocal,
      allowedPorts,
    };
  }

  async run(): Promise<LinkScanResult> {
    this.done = await this.input.sink.alreadyChecked();
    this.pagesChecked = this.input.pages.filter((p) => this.done.pages.has(p.url)).length;

    await this.phase(() => this.fetchPages());
    if (!this.stopped()) await this.phase(() => this.checkLinks());

    const truncated = this.timeUp ? "time_limit" : this.linkCap ? "link_cap" : null;
    return { outcome: this.cancelled ? "cancelled" : "completed", truncated };
  }

  /** Runs a phase, then writes what it produced and reports progress. */
  private async phase(work: () => Promise<void>): Promise<void> {
    await work();
    await this.pendingProgress;
    this.throwIfFailed();
    await this.reportProgress();
    this.throwIfFailed();
  }

  private async fetchPages(): Promise<void> {
    const { pages } = this.input;
    // Links are merged in page order whatever order fetches finish in, so found_in, labels and
    // the link cap are deterministic. A page's links are held only until they are merged.
    const held: (PageLink[] | null)[] = new Array<null>(pages.length).fill(null);
    const settled: boolean[] = new Array<boolean>(pages.length).fill(false);
    let next = 0;
    const merge = (): void => {
      for (; next < pages.length && settled[next]; next++) {
        const links = held[next];
        held[next] = null;
        if (links) this.addLinks(pages[next]?.url ?? "", links);
      }
      const { onHeld } = this.input;
      if (onHeld) {
        onHeld({ pages: held.filter((h) => h !== null).length, entries: held.reduce((n, h) => n + (h?.length ?? 0), 0) });
      }
    };
    await settleAll(
      pages.map((page, i) =>
        this.originLimit(ORIGIN_KEY, async () => {
          held[i] = await this.checkPage(page);
          settled[i] = true;
          merge();
          this.tick();
        }),
      ),
    );
  }

  /** Records the page row and returns its links, or null when it has none to give. */
  private async checkPage(page: { url: string; source: string }): Promise<PageLink[] | null> {
    const r = await this.request(page.url, PAGE_REQUEST);
    if (r === STOPPED) return null;
    let check = classify(page.url, r);
    let robots: Pick<ResultRow, "robots_index" | "robots_follow"> = { robots_index: null, robots_follow: null };
    let extracted: ExtractedPage | null = null;
    if (!(r instanceof SafeFetchError) && r.status >= 200 && r.status < 300 && isHtml(r.headers)) {
      if (r.truncated) {
        check = { status: "warning", httpCode: r.status, detail: TOO_LARGE };
      } else if (sameOrigin(r.finalUrl, this.input.origin)) {
        extracted = extractPage(r.body, r.finalUrl, r.headers);
        robots = { robots_index: extracted.robotsIndex, robots_follow: extracted.robotsFollow };
      }
    }
    this.pageChecks.set(pageKey(page.url), check);
    if (!this.done.pages.has(page.url)) {
      this.pagesChecked++;
      this.queueRow({
        kind: "page",
        url: page.url,
        label: null,
        source: page.source,
        found_in: null,
        found_count: 1,
        ...this.checkColumns(check),
        ...robots,
      });
    }
    return extracted && this.pageLinks(extracted);
  }

  /** The page's links in merge order. Once the link cap is full only links already kept can count. */
  private pageLinks(page: ExtractedPage): PageLink[] {
    const out: PageLink[] = [];
    for (const link of page.links) {
      if (isWpClutter(link.url, this.input.origin)) continue;
      const tooLong = link.url.length > URL_MAX;
      out.push({ url: link.url.slice(0, URL_MAX), label: link.label, skipped: tooLong ? INVALID : null });
    }
    for (const s of page.skipped) {
      const detail = s.reason === "invalid" || s.href.length > URL_MAX ? INVALID : NOT_WEB;
      out.push({ url: s.href.slice(0, URL_MAX), label: s.label, skipped: detail });
    }
    if (this.links.size < SCAN_LIMITS.maxLinks) return out;
    const known = out.filter((l) => this.links.has(l.url));
    if (known.length < out.length) this.linkCap = true;
    return known;
  }

  private addLinks(foundIn: string, links: PageLink[]): void {
    for (const link of links) this.addLink(link.url, link.label, foundIn, link.skipped);
  }

  private addLink(url: string, label: string | null, foundIn: string, skipped: string | null): void {
    const existing = this.links.get(url);
    if (existing) {
      existing.foundCount++;
      existing.label ??= label;
      return;
    }
    if (this.links.size >= SCAN_LIMITS.maxLinks) {
      this.linkCap = true;
      return;
    }
    this.links.set(url, { url, label, foundIn, foundCount: 1, skipped });
    if (this.done.links.has(url)) this.linksChecked++;
  }

  private async checkLinks(): Promise<void> {
    const pending = [...this.links.values()].filter((link) => !this.done.links.has(link.url));
    await settleAll(pending.map((link) => this.checkLink(link)));
  }

  private async checkLink(link: LinkEntry): Promise<void> {
    if (link.skipped !== null) return this.recordLink(link, { status: "skipped", httpCode: null, detail: link.skipped });
    const pageCheck = this.pageChecks.get(link.url);
    if (pageCheck) return this.recordLink(link, pageCheck);

    if (sameOrigin(link.url, this.input.origin)) {
      return this.originLimit(ORIGIN_KEY, async () => {
        const r = await this.request(link.url, LINK_GET);
        if (r !== STOPPED) this.recordLink(link, classify(link.url, r));
      });
    }
    return this.externalLimit(new URL(link.url).host, async () => {
      let r = await this.request(link.url, LINK_HEAD);
      if (r !== STOPPED && headInconclusive(r)) r = await this.request(link.url, LINK_GET);
      if (r !== STOPPED) this.recordLink(link, classify(link.url, r));
    });
  }

  private recordLink(link: LinkEntry, check: Check): void {
    this.linksChecked++;
    this.queueRow({
      kind: "link",
      url: link.url,
      label: link.label,
      source: "page",
      found_in: link.foundIn,
      found_count: link.foundCount,
      ...this.checkColumns(check),
      robots_index: null,
      robots_follow: null,
    });
    this.tick();
  }

  private checkColumns(check: Check): Pick<ResultRow, "status" | "http_code" | "detail"> {
    return { status: check.status, http_code: check.httpCode, detail: check.detail?.slice(0, DETAIL_MAX) ?? null };
  }

  /**
   * One fetch, unless the scan is stopping. When no progress report is in flight the check and the
   * fetch happen in the same tick, so nothing starts after the deadline or a cancel is seen.
   */
  private async request(url: string, opts: SafeFetchOptions): Promise<FetchResult> {
    if (this.pendingProgress) await this.pendingProgress;
    if (this.stopped()) return STOPPED;
    try {
      return await this.input.fetcher(url, { ...this.requestBase, ...opts });
    } catch (err) {
      if (err instanceof SafeFetchError) return err;
      this.failure ??= { error: err };
      throw err;
    }
  }

  private stopped(): boolean {
    if (this.failure || this.cancelled || this.timeUp) return true;
    if (this.input.now() >= this.input.deadlineAt) this.timeUp = true;
    return this.timeUp;
  }

  private throwIfFailed(): void {
    if (this.failure) throw this.failure.error;
  }

  private queueRow(row: ResultRow): void {
    this.buffer.push(row);
    if (this.buffer.length >= BATCH_SIZE) void this.flush(false);
  }

  /** Queues full batches (and with `all`, the remainder) behind earlier writes, in order. */
  private flush(all: boolean): Promise<void> {
    while (this.buffer.length >= BATCH_SIZE || (all && this.buffer.length > 0)) {
      const batch = this.buffer.splice(0, BATCH_SIZE);
      this.writes = this.writes
        .then(() => (this.failure ? undefined : this.input.sink.writeResults(batch)))
        .catch((err: unknown) => {
          this.failure ??= { error: err };
        });
    }
    return this.writes;
  }

  /** Reports progress when a second has passed since the last report. */
  private tick(): void {
    if (this.pendingProgress || this.input.now() - this.lastProgressAt < PROGRESS_INTERVAL_MS) return;
    this.pendingProgress = this.reportProgress()
      .catch((err: unknown) => {
        this.failure ??= { error: err };
      })
      .finally(() => {
        this.pendingProgress = null;
      });
  }

  private async reportProgress(): Promise<void> {
    this.lastProgressAt = this.input.now();
    await this.flush(true);
    this.throwIfFailed();
    const answer = await this.input.sink.progress({
      pagesTotal: this.input.pages.length,
      pagesChecked: this.pagesChecked,
      linksTotal: this.links.size,
      linksChecked: this.linksChecked,
    });
    if (answer === "cancelled") this.cancelled = true;
  }
}

export function runLinkScan(input: LinkScanInput): Promise<LinkScanResult> {
  return new LinkScan(input).run();
}
