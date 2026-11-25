import { describe, expect, it } from "vitest";
import { isWpClutter, normalizeLinkUrl, sameOrigin } from "./links.js";

describe("normalizeLinkUrl", () => {
  const cases: [string, string, string][] = [
    ["../b", "https://ex.com/a/c/", "https://ex.com/a/b"],
    ["//cdn.ex.com/x", "https://ex.com/", "https://cdn.ex.com/x"],
    ["HTTP://Example.COM:80/p?utm_source=x&id=2#top", "https://ex.com/", "http://example.com/p?id=2"],
    ["https://bücher.de/", "https://ex.com/", "https://xn--bcher-kva.de/"],
    [" /a b ", "https://ex.com/", "https://ex.com/a%20b"],
    ["/x?fbclid=1&gclid=2", "https://ex.com/", "https://ex.com/x"],
    ["/x?b=1&a=2&utm_id=3", "https://ex.com/", "https://ex.com/x?b=1&a=2"],
  ];
  it.each(cases)("%s against %s", (href, base, url) => {
    expect(normalizeLinkUrl(href, base)).toEqual({ ok: true, url });
  });
  it("rejects non-http schemes", () => {
    expect(normalizeLinkUrl("mailto:a@b.c", "https://ex.com/")).toEqual({ ok: false, reason: "scheme" });
  });
  it.each(["", "#", "http://[bad"])("rejects %j as invalid", (href) => {
    expect(normalizeLinkUrl(href, "https://ex.com/")).toEqual({ ok: false, reason: "invalid" });
  });
});

describe("isWpClutter", () => {
  const o = "https://ex.com";
  it.each([
    "https://ex.com/?replytocom=5",
    "https://ex.com/feed/",
    "https://ex.com/post/feed",
    "https://ex.com/comments/feed/",
    "https://ex.com/wp-login.php?x",
    "https://ex.com/wp-admin/",
    "https://ex.com/xmlrpc.php",
    "https://ex.com/wp-json/wp/v2",
    "https://ex.com/?share=twitter",
  ])("flags %s", (u) => expect(isWpClutter(u, o)).toBe(true));
  it("ignores other origins and lookalikes", () => {
    expect(isWpClutter("https://other.com/feed/", o)).toBe(false);
    expect(isWpClutter("https://ex.com/feedback/", o)).toBe(false);
  });
});

describe("sameOrigin", () => {
  it("compares normalized origins", () => {
    expect(sameOrigin("HTTPS://Ex.com:443/x", "https://ex.com")).toBe(true);
    expect(sameOrigin("http://ex.com/", "https://ex.com")).toBe(false);
    expect(sameOrigin("garbage", "https://ex.com")).toBe(false);
  });

  it("compares IP-host origins (local sites)", () => {
    expect(sameOrigin("http://127.0.0.1:8080/a", "http://127.0.0.1:8080")).toBe(true);
    expect(sameOrigin("http://127.0.0.1:8081/a", "http://127.0.0.1:8080")).toBe(false);
    expect(sameOrigin("http://127.0.0.1/a", "https://example.com")).toBe(false);
  });
});
