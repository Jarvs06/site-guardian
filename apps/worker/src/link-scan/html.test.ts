import { describe, expect, it } from "vitest";
import { extractPage } from "./html.js";

const PAGE = "https://ex.com/page/";

describe("extractPage", () => {
  it("collects nav, footer and content links, resolving against <base href>", () => {
    const html = `<html><head><base href="https://ex.com/sub/"><base href="https://other.com/"></head>
      <body><nav><a href="x">  Home \n  page </a></nav><main><a href="/abs">Abs</a></main>
      <footer><a href="https://ext.com/z?utm_source=a">Ext</a></footer></body></html>`;
    const r = extractPage(html, PAGE, {});
    expect(r.links).toEqual([
      { url: "https://ex.com/sub/x", label: "Home page" },
      { url: "https://ex.com/abs", label: "Abs" },
      { url: "https://ext.com/z", label: "Ext" },
    ]);
  });

  it("resolves against the final url when there is no base, and applies base only to later links", () => {
    const r = extractPage(`<a href="a">A</a><base href="https://ex.com/b/"><a href="c">C</a>`, PAGE, {});
    expect(r.links.map((l) => l.url)).toEqual(["https://ex.com/page/a", "https://ex.com/b/c"]);
  });

  it("returns duplicates and null labels for empty text", () => {
    const r = extractPage(`<a href="/a">One</a><a href="/a"><img src="x.png"></a>`, PAGE, {});
    expect(r.links).toEqual([
      { url: "https://ex.com/a", label: "One" },
      { url: "https://ex.com/a", label: null },
    ]);
  });

  it("cuts labels to 200 chars", () => {
    const r = extractPage(`<a href="/a">${"x".repeat(500)}</a>`, PAGE, {});
    expect(r.links[0]?.label).toHaveLength(200);
  });

  it("skips non-http schemes, keeping the trimmed raw href", () => {
    const r = extractPage(`<a href=" mailto:a@b ">Mail</a><a href="tel:1">T</a><a href="javascript:void(0)">J</a>`, PAGE, {});
    expect(r.links).toEqual([]);
    expect(r.skipped[0]).toEqual({ href: "mailto:a@b", reason: "scheme", label: "Mail" });
    expect(r.skipped.map((s) => s.reason)).toEqual(["scheme", "scheme", "scheme"]);
  });

  it("marks unparseable hrefs as invalid", () => {
    const r = extractPage(`<a href="http://[bad">B</a>`, PAGE, {});
    expect(r.skipped).toEqual([{ href: "http://[bad", reason: "invalid", label: "B" }]);
  });

  it("drops bare and same-page anchors everywhere", () => {
    const r = extractPage(`<a href="#">Top</a><a href="#top">Top</a><a href="">E</a><a>none</a>`, PAGE, {});
    expect(r.links).toEqual([]);
    expect(r.skipped).toEqual([]);
  });

  it("reads robots meta case-insensitively with comma lists", () => {
    const r = extractPage(`<meta name="ROBOTS" content="NoIndex, follow">`, PAGE, {});
    expect([r.robotsIndex, r.robotsFollow]).toEqual(["noindex", "follow"]);
    const g = extractPage(`<meta name="googlebot" content="nofollow">`, PAGE, {});
    expect([g.robotsIndex, g.robotsFollow]).toEqual(["index", "nofollow"]);
    const o = extractPage(`<meta name="bingbot" content="noindex">`, PAGE, {});
    expect([o.robotsIndex, o.robotsFollow]).toEqual(["index", "follow"]);
  });

  it("treats none as noindex+nofollow, in meta and header", () => {
    const m = extractPage(`<meta name="robots" content="none">`, PAGE, {});
    expect([m.robotsIndex, m.robotsFollow]).toEqual(["noindex", "nofollow"]);
    const h = extractPage("", PAGE, { "x-robots-tag": "none" });
    expect([h.robotsIndex, h.robotsFollow]).toEqual(["noindex", "nofollow"]);
  });

  it("ignores bot-specific x-robots-tag directives", () => {
    const r = extractPage("", PAGE, { "X-Robots-Tag": "otherbot: noindex" });
    expect([r.robotsIndex, r.robotsFollow]).toEqual(["index", "follow"]);
    const r2 = extractPage("", PAGE, { "x-robots-tag": "otherbot: noindex, nofollow" });
    expect([r2.robotsIndex, r2.robotsFollow]).toEqual(["index", "follow"]);
    const r3 = extractPage("", PAGE, { "x-robots-tag": "nofollow, otherbot: noindex" });
    expect([r3.robotsIndex, r3.robotsFollow]).toEqual(["index", "nofollow"]);
  });

  it("keeps at most 5,000 links and skipped hrefs per page but still reads robots after them", () => {
    const anchors = Array.from({ length: 6000 }, (_, i) => (i % 2 ? `<a href=/a${i}>x</a>` : `<a href=tel:${i}>x</a>`));
    const r = extractPage(`${anchors.join("")}<meta name="robots" content="noindex">`, PAGE, {});
    expect(r.links.length + r.skipped.length).toBe(5000);
    expect(r.robotsIndex).toBe("noindex");
  });

  it("does not throw on malformed html", () => {
    const r = extractPage(`<div><a href="/a">open <b>bold<a href="/b">next<p><a href="/c"`, PAGE, {});
    expect(r.links.map((l) => l.url)).toEqual(["https://ex.com/a", "https://ex.com/b"]);
  });
});
