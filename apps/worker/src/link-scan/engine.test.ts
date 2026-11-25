import { SafeFetchError, safeFetch, type SafeFetchOptions, type SafeFetchResponse } from "@sg/shared";
import { describe, expect, it } from "vitest";
import { runLinkScan, type ResultRow, type ScanSink } from "./engine.js";
import { createKeyedLimiter } from "./limits.js";

const ORIGIN = "https://ex.com";
const UA = "SiteGuardianBot/test (+https://siteguardian.ai/bot)";
const HTML = { "content-type": "text/html; charset=utf-8" };

type Reply = Partial<SafeFetchResponse> | SafeFetchError | Error;
type Route = Reply | ((call: Call) => Reply | Promise<Reply>);
type Call = { url: string; method: string; opts: SafeFetchOptions };

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function htmlPage(hrefs: string[], extra = ""): Partial<SafeFetchResponse> {
  return {
    status: 200,
    headers: HTML,
    body: `<html><head>${extra}</head><body>${hrefs.map((h, i) => `<a href="${h}">L${i}</a>`).join("")}</body></html>`,
  };
}

/** Routes keyed by "METHOD url" or plain url; unknown URLs answer 200 with an empty body. */
function fakeFetcher(routes: Record<string, Route>, opts: { onCall?: (c: Call) => void; fallback?: Route } = {}) {
  const calls: Call[] = [];
  const fetcher = (async (url: string, o: SafeFetchOptions = {}): Promise<SafeFetchResponse> => {
    const call = { url, method: o.method ?? "GET", opts: o };
    calls.push(call);
    opts.onCall?.(call);
    const route = routes[`${call.method} ${url}`] ?? routes[url] ?? opts.fallback ?? { status: 200 };
    const reply = typeof route === "function" ? await route(call) : route;
    if (reply instanceof Error) throw reply;
    return { status: 200, finalUrl: url, headers: {}, body: "", truncated: false, ...reply };
  }) as typeof safeFetch;
  return { fetcher, calls };
}

function memorySink(
  init: { pages?: string[]; links?: string[]; progress?: (n: number) => "continue" | "cancelled" } = {},
) {
  const rows: ResultRow[] = [];
  const progress: Parameters<ScanSink["progress"]>[0][] = [];
  const batches: number[] = [];
  const sink: ScanSink = {
    alreadyChecked: () => Promise.resolve({ pages: new Set(init.pages ?? []), links: new Set(init.links ?? []) }),
    writeResults: (r) => {
      batches.push(r.length);
      rows.push(...r);
      return Promise.resolve();
    },
    progress: (p) => {
      progress.push(p);
      return Promise.resolve(init.progress?.(progress.length) ?? "continue");
    },
  };
  const link = (url: string) => rows.find((r) => r.kind === "link" && r.url === url);
  const page = (url: string) => rows.find((r) => r.kind === "page" && r.url === url);
  return { sink, rows, progress, batches, link, page };
}

function run(
  pages: { url: string; source?: string }[],
  fetcher: typeof safeFetch,
  sink: ScanSink,
  extra: { now?: () => number; deadlineAt?: number; allowLocal?: boolean; origin?: string } = {},
) {
  return runLinkScan({
    origin: extra.origin ?? ORIGIN,
    pages: pages.map((p) => ({ url: p.url, source: p.source ?? "page" })),
    allowLocal: extra.allowLocal ?? false,
    userAgent: UA,
    fetcher,
    sink,
    now: extra.now ?? (() => 0),
    deadlineAt: extra.deadlineAt ?? 1_000_000,
  });
}

describe("createKeyedLimiter", () => {
  it("caps per key and in total", async () => {
    const limit = createKeyedLimiter(2, 3);
    const inFlight = new Map<string, number>();
    let total = 0;
    let maxTotal = 0;
    const maxByKey = new Map<string, number>();
    const task = (key: string) =>
      limit(key, async () => {
        total++;
        inFlight.set(key, (inFlight.get(key) ?? 0) + 1);
        maxTotal = Math.max(maxTotal, total);
        maxByKey.set(key, Math.max(maxByKey.get(key) ?? 0, inFlight.get(key) ?? 0));
        await delay(2);
        total--;
        inFlight.set(key, (inFlight.get(key) ?? 1) - 1);
        return key;
      });
    const keys = ["a", "a", "a", "a", "b", "b", "b", "c", "c"];
    expect(await Promise.all(keys.map(task))).toEqual(keys);
    expect(maxTotal).toBe(3);
    expect(Math.max(...maxByKey.values())).toBe(2);
  });

  it("passes a rejection through and frees the slot", async () => {
    const limit = createKeyedLimiter(1, 1);
    await expect(limit("a", () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    await expect(limit("a", () => Promise.resolve(1))).resolves.toBe(1);
  });
});

describe("runLinkScan", () => {
  it("dedupes a shared footer link into one row checked once with HEAD", async () => {
    const { fetcher, calls } = fakeFetcher({
      "https://ex.com/": htmlPage(["https://ext.com/a"]),
      "https://ex.com/b/": htmlPage(["https://ext.com/a"]),
      "https://ext.com/a": { status: 404 },
    });
    const s = memorySink();
    const result = await run([{ url: "https://ex.com/", source: "home" }, { url: "https://ex.com/b/" }], fetcher, s.sink);
    expect(result).toEqual({ outcome: "completed", truncated: null });
    expect(s.rows.filter((r) => r.kind === "link")).toEqual([
      {
        kind: "link",
        url: "https://ext.com/a",
        label: "L0",
        source: "page",
        found_in: "https://ex.com/",
        found_count: 2,
        status: "broken",
        http_code: 404,
        detail: "Page not found (404)",
        robots_index: null,
        robots_follow: null,
      },
    ]);
    expect(s.page("https://ex.com/")).toMatchObject({
      source: "home",
      status: "ok",
      http_code: 200,
      robots_index: "index",
      robots_follow: "follow",
      found_in: null,
      found_count: 1,
    });
    expect(calls.filter((c) => c.url === "https://ext.com/a").map((c) => c.method)).toEqual(["HEAD"]);
  });

  it("fetches pages with the page limits and sends only User-Agent and Accept", async () => {
    const { fetcher, calls } = fakeFetcher({ "https://ex.com/": htmlPage(["/x", "https://ext.com/y"]) });
    await run([{ url: "https://ex.com/" }], fetcher, memorySink().sink);
    const [page, same, ext] = calls;
    expect(page?.opts).toMatchObject({
      method: "GET",
      maxBytes: 2_097_152,
      timeoutMs: 15_000,
      allowPrivate: false,
      allowedPorts: [80, 443],
    });
    expect(same).toMatchObject({ url: "https://ex.com/x", method: "GET", opts: { maxBytes: 65_536, timeoutMs: 10_000 } });
    expect(ext).toMatchObject({ url: "https://ext.com/y", method: "HEAD", opts: { timeoutMs: 10_000 } });
    for (const c of calls) expect(Object.keys(c.opts.headers ?? {}).sort()).toEqual(["Accept", "User-Agent"]);
    expect(page?.opts.headers?.["User-Agent"]).toBe(UA);
  });

  it("adds the origin port to allowedPorts only for local sites", async () => {
    const { fetcher, calls } = fakeFetcher({});
    await run([{ url: "http://127.0.0.1:8080/" }], fetcher, memorySink().sink, {
      origin: "http://127.0.0.1:8080",
      allowLocal: true,
    });
    expect(calls[0]?.opts).toMatchObject({ allowPrivate: true, allowedPorts: [80, 443, 8080] });
  });

  it("records a page that redirects off-origin as redirect and takes no links from it", async () => {
    const { fetcher, calls } = fakeFetcher({
      "https://ex.com/go/": { ...htmlPage(["https://ext.com/z"]), finalUrl: "https://other.com/landing" },
    });
    const s = memorySink();
    await run([{ url: "https://ex.com/go/" }], fetcher, s.sink);
    expect(s.page("https://ex.com/go/")).toMatchObject({
      status: "redirect",
      detail: "Redirects to https://other.com/landing",
    });
    expect(s.rows.filter((r) => r.kind === "link")).toEqual([]);
    expect(calls.map((c) => c.url)).toEqual(["https://ex.com/go/"]);
  });

  it("records a non-HTML page as ok with null robots and no links", async () => {
    const { fetcher, calls } = fakeFetcher({
      "https://ex.com/f.pdf": { status: 200, headers: { "content-type": "application/pdf" }, body: '<a href="/x">x</a>' },
    });
    const s = memorySink();
    await run([{ url: "https://ex.com/f.pdf" }], fetcher, s.sink);
    expect(s.page("https://ex.com/f.pdf")).toMatchObject({ status: "ok", robots_index: null, robots_follow: null });
    expect(s.rows).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("records a truncated HTML page as a warning and takes no links from it", async () => {
    const { fetcher, calls } = fakeFetcher({ "https://ex.com/big/": { ...htmlPage(["/x"]), truncated: true } });
    const s = memorySink();
    await run([{ url: "https://ex.com/big/" }], fetcher, s.sink);
    expect(s.page("https://ex.com/big/")).toMatchObject({
      status: "warning",
      http_code: 200,
      detail: "Page too large to read fully",
      robots_index: null,
      robots_follow: null,
    });
    expect(s.rows).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("records a failed page fetch with the error classification", async () => {
    const { fetcher } = fakeFetcher({ "https://ex.com/": new SafeFetchError("dns_failed", "x") });
    const s = memorySink();
    expect(await run([{ url: "https://ex.com/" }], fetcher, s.sink)).toEqual({ outcome: "completed", truncated: null });
    expect(s.page("https://ex.com/")).toMatchObject({ status: "broken", http_code: null, robots_index: null });
  });

  it("reads robots from the page", async () => {
    const { fetcher } = fakeFetcher({
      "https://ex.com/": htmlPage([], '<meta name="robots" content="noindex">'),
    });
    const s = memorySink();
    await run([{ url: "https://ex.com/" }], fetcher, s.sink);
    expect(s.page("https://ex.com/")).toMatchObject({ robots_index: "noindex", robots_follow: "follow" });
  });

  it("lets a hung external host time out while other links complete, and still completes", async () => {
    const done: string[] = [];
    const hung = () => delay(20).then(() => new SafeFetchError("timeout", "slow"));
    const hrefs = ["https://hung.com/1", "https://hung.com/2", "https://fast.com/1", "https://fast.com/2"];
    const { fetcher } = fakeFetcher(
      {
        "https://ex.com/": htmlPage(hrefs),
        "https://hung.com/1": hung,
        "https://hung.com/2": hung,
        "https://fast.com/1": () => (done.push("fast1"), { status: 200 }),
        "https://fast.com/2": () => (done.push("fast2"), { status: 200 }),
      },
      { onCall: (c) => c.url.startsWith("https://hung.com/") && c.method === "GET" && done.push(`hung-get ${c.url}`) },
    );
    const s = memorySink();
    expect(await run([{ url: "https://ex.com/" }], fetcher, s.sink)).toEqual({ outcome: "completed", truncated: null });
    expect(done.slice(0, 2)).toEqual(["fast1", "fast2"]);
    for (const url of ["https://hung.com/1", "https://hung.com/2"]) {
      expect(s.link(url)).toMatchObject({ status: "warning", http_code: null, detail: "Timed out" });
    }
    expect(s.link("https://fast.com/1")?.status).toBe("ok");
  });

  it("reuses a page's result for a link to it, with no second fetch", async () => {
    const { fetcher, calls } = fakeFetcher({
      "https://ex.com/": htmlPage(["/about/"]),
      "https://ex.com/about/": { status: 404 },
    });
    const s = memorySink();
    await run([{ url: "https://ex.com/" }, { url: "https://ex.com/about/" }], fetcher, s.sink);
    expect(calls.filter((c) => c.url === "https://ex.com/about/")).toHaveLength(1);
    expect(s.link("https://ex.com/about/")).toMatchObject({
      status: "broken",
      http_code: 404,
      detail: "Page not found (404)",
      found_in: "https://ex.com/",
    });
  });

  it("falls back to GET when HEAD gets 405", async () => {
    const { fetcher, calls } = fakeFetcher({
      "https://ex.com/": htmlPage(["https://ext.com/h"]),
      "HEAD https://ext.com/h": { status: 405 },
      "GET https://ext.com/h": { status: 200 },
    });
    const s = memorySink();
    await run([{ url: "https://ex.com/" }], fetcher, s.sink);
    expect(s.link("https://ext.com/h")).toMatchObject({ status: "ok", http_code: 200 });
    const get = calls.find((c) => c.url === "https://ext.com/h" && c.method === "GET");
    expect(get?.opts).toMatchObject({ maxBytes: 65_536, timeoutMs: 10_000 });
  });

  it("falls back to GET on a network failure but not on a 404", async () => {
    const { fetcher, calls } = fakeFetcher({
      "https://ex.com/": htmlPage(["https://ext.com/n", "https://ext.com/m"]),
      "HEAD https://ext.com/n": new SafeFetchError("network_error", "reset"),
      "HEAD https://ext.com/m": { status: 404 },
    });
    const s = memorySink();
    await run([{ url: "https://ex.com/" }], fetcher, s.sink);
    expect(s.link("https://ext.com/n")?.status).toBe("ok");
    expect(calls.filter((c) => c.url === "https://ext.com/m").map((c) => c.method)).toEqual(["HEAD"]);
  });

  it("drops WordPress clutter with no row", async () => {
    const { fetcher, calls } = fakeFetcher({ "https://ex.com/": htmlPage(["https://ex.com/?replytocom=3"]) });
    const s = memorySink();
    await run([{ url: "https://ex.com/" }], fetcher, s.sink);
    expect(s.rows.filter((r) => r.kind === "link")).toEqual([]);
    expect(calls).toHaveLength(1);
  });

  it("records skipped hrefs once with the trimmed raw href, and over-long URLs as invalid", async () => {
    const long = `https://ext.com/${"a".repeat(2100)}`;
    const { fetcher, calls } = fakeFetcher({
      "https://ex.com/": htmlPage(["mailto:hi@ex.com", " mailto:hi@ex.com ", "http://[bad", long]),
      "https://ex.com/2/": htmlPage(["mailto:hi@ex.com"]),
    });
    const s = memorySink();
    await run([{ url: "https://ex.com/" }, { url: "https://ex.com/2/" }], fetcher, s.sink);
    expect(s.link("mailto:hi@ex.com")).toMatchObject({
      status: "skipped",
      http_code: null,
      detail: "Not checked: not a web link",
      found_count: 3,
    });
    expect(s.link("http://[bad")).toMatchObject({ status: "skipped", detail: "Invalid link" });
    expect(s.link(long.slice(0, 2048))).toMatchObject({ status: "skipped", detail: "Invalid link" });
    expect(s.rows.every((r) => r.url.length <= 2048)).toBe(true);
    expect(calls.map((c) => c.url)).toEqual(["https://ex.com/", "https://ex.com/2/"]);
  });

  it("stops adding links at 5,000 and reports link_cap", async () => {
    const pages = Array.from({ length: 51 }, (_, p) => ({ url: `https://ex.com/p${p}/` }));
    const routes: Record<string, Route> = {};
    for (const [p, page] of pages.entries()) {
      routes[page.url] = htmlPage(Array.from({ length: 100 }, (_, i) => `/l${p}-${i}`));
    }
    const { fetcher } = fakeFetcher(routes);
    const s = memorySink();
    const result = await run(pages, fetcher, s.sink);
    expect(result).toEqual({ outcome: "completed", truncated: "link_cap" });
    expect(s.rows.filter((r) => r.kind === "link")).toHaveLength(5000);
    expect(s.link("https://ex.com/l49-99")).toBeDefined();
    expect(s.link("https://ex.com/l50-0")).toBeUndefined();
    expect(Math.max(...s.batches)).toBeLessThanOrEqual(100);
    expect(s.progress.at(-1)).toEqual({ pagesTotal: 51, pagesChecked: 51, linksTotal: 5000, linksChecked: 5000 });
  });

  it("stops scheduling after the sink reports cancelled", async () => {
    const pages = Array.from({ length: 10 }, (_, i) => ({ url: `https://ex.com/p${i}/` }));
    const { fetcher, calls } = fakeFetcher({});
    let callsAtCancel = -1;
    const s = memorySink({
      progress: () => {
        callsAtCancel = calls.length;
        return "cancelled";
      },
    });
    expect(await run(pages, fetcher, s.sink)).toEqual({ outcome: "cancelled", truncated: null });
    expect(callsAtCancel).toBeGreaterThan(0);
    expect(calls).toHaveLength(callsAtCancel);
    expect(calls.length).toBeLessThan(10);
  });

  it("calls progress at most once a second", async () => {
    let clock = 0;
    const hrefs = Array.from({ length: 30 }, (_, i) => `/x${i}`);
    const { fetcher } = fakeFetcher({ "https://ex.com/": htmlPage(hrefs) }, { onCall: () => (clock += 100) });
    const s = memorySink();
    await run([{ url: "https://ex.com/" }], fetcher, s.sink, { now: () => clock, deadlineAt: 1e9 });
    // 31 requests, 3.1 s of fake time: a first call, ~3 timed calls and one per phase end.
    expect(s.progress.length).toBeGreaterThanOrEqual(3);
    expect(s.progress.length).toBeLessThanOrEqual(6);
  });

  it("returns completed with time_limit once the deadline passes", async () => {
    let clock = 0;
    const pages = Array.from({ length: 5 }, (_, i) => ({ url: `https://ex.com/p${i}/` }));
    const { fetcher, calls } = fakeFetcher({}, { onCall: () => (clock = 100) });
    const s = memorySink();
    const result = await run(pages, fetcher, s.sink, { now: () => clock, deadlineAt: 100 });
    expect(result).toEqual({ outcome: "completed", truncated: "time_limit" });
    expect(calls.map((c) => c.url)).toEqual(["https://ex.com/p0/"]);
    expect(s.page("https://ex.com/p0/")).toBeDefined();
  });

  it("skips private-network links with the real safeFetch (no connection is made)", async () => {
    const page = "https://ex.com/";
    const seen: string[] = [];
    const fetcher = ((url: string, o?: SafeFetchOptions) => {
      seen.push(url);
      if (url === page) {
        const body = htmlPage([
          "http://169.254.169.254/latest",
          "http://127.0.0.1/x",
          "http://127.0.0.1:8080/x",
        ]).body;
        return Promise.resolve({ status: 200, finalUrl: page, headers: HTML, body: body ?? "", truncated: false });
      }
      return safeFetch(url, o);
    }) as typeof safeFetch;
    const s = memorySink();
    await run([{ url: page }], fetcher, s.sink, { allowLocal: false });
    const PRIVATE = { status: "skipped", http_code: null, detail: "Not checked: points to a private network address" };
    expect(s.link("http://169.254.169.254/latest")).toMatchObject(PRIVATE);
    expect(s.link("http://127.0.0.1/x")).toMatchObject(PRIVATE);
    // safe-fetch refuses the port before looking at the address: still skipped and never connected.
    expect(s.link("http://127.0.0.1:8080/x")).toMatchObject({ status: "skipped", detail: "Not checked: port not allowed" });
  });

  it("does not fetch or rewrite URLs already checked", async () => {
    const { fetcher, calls } = fakeFetcher({
      "https://ex.com/": htmlPage(["/done1", "https://ext.com/done2", "/new"]),
    });
    const s = memorySink({ pages: ["https://ex.com/"], links: ["https://ex.com/done1", "https://ext.com/done2"] });
    await run([{ url: "https://ex.com/" }], fetcher, s.sink);
    expect(calls.map((c) => c.url)).toEqual(["https://ex.com/", "https://ex.com/new"]);
    expect(s.rows.map((r) => r.url)).toEqual(["https://ex.com/new"]);
    expect(s.progress.at(-1)).toEqual({ pagesTotal: 1, pagesChecked: 1, linksTotal: 3, linksChecked: 3 });
  });

  it("propagates a non-SafeFetchError so the job can retry", async () => {
    const { fetcher } = fakeFetcher({ "https://ex.com/": htmlPage(["/a"]), "https://ex.com/a": new Error("db gone") });
    await expect(run([{ url: "https://ex.com/" }], fetcher, memorySink().sink)).rejects.toThrow("db gone");
  });

  it("keeps the origin at 4 requests and each external host at 2", async () => {
    const inFlight = new Map<string, number>();
    const max = new Map<string, number>();
    const slow = async (c: Call): Promise<Reply> => {
      const host = new URL(c.url).host;
      inFlight.set(host, (inFlight.get(host) ?? 0) + 1);
      max.set(host, Math.max(max.get(host) ?? 0, inFlight.get(host) ?? 0));
      await delay(2);
      inFlight.set(host, (inFlight.get(host) ?? 1) - 1);
      return { status: 200, headers: HTML, body: "" };
    };
    const hrefs = [
      ...Array.from({ length: 12 }, (_, i) => `/s${i}`),
      ...Array.from({ length: 6 }, (_, i) => `https://a.com/${i}`),
      ...Array.from({ length: 6 }, (_, i) => `https://b.com/${i}`),
    ];
    const pages = Array.from({ length: 8 }, (_, i) => ({ url: `https://ex.com/p${i}/` }));
    const routes: Record<string, Route> = {};
    for (const p of pages) routes[p.url] = async (c) => (await slow(c), htmlPage(hrefs));
    const { fetcher } = fakeFetcher(routes, { fallback: slow });
    await run(pages, fetcher, memorySink().sink);
    expect(max.get("ex.com")).toBe(4);
    expect(max.get("a.com")).toBe(2);
    expect(max.get("b.com")).toBe(2);
  });
});
