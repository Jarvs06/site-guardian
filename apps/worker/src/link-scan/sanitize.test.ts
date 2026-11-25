import { describe, expect, it } from "vitest";
import type { ResultRow } from "./engine.js";
import { sanitizeRow } from "./sanitize.js";

const ROW: ResultRow = {
  kind: "link",
  url: "https://ex.com/a",
  label: "A",
  source: "page",
  found_in: "https://ex.com/",
  found_count: 1,
  status: "ok",
  http_code: 200,
  detail: null,
  robots_index: null,
  robots_follow: null,
};
const EMOJI = "\u{1F600}";
const isWellFormed = (s: string) => !/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/.test(s);

describe("sanitizeRow", () => {
  it("removes NUL characters from every text column", () => {
    const r = sanitizeRow({ ...ROW, url: "mailto:a\u0000b", label: "\u0000x", found_in: "f\u0000", detail: "d\u0000" });
    expect(r).toMatchObject({ url: "mailto:ab", label: "x", found_in: "f", detail: "d" });
  });

  it("replaces lone surrogates", () => {
    const r = sanitizeRow({ ...ROW, label: "a\uD83D", url: "b\uDE00c" });
    expect(isWellFormed(r.label ?? "")).toBe(true);
    expect(isWellFormed(r.url)).toBe(true);
  });

  it("cuts by code points, never splitting a surrogate pair", () => {
    const r = sanitizeRow({
      ...ROW,
      label: `${"x".repeat(199)}${EMOJI}${EMOJI}`,
      detail: `${"x".repeat(499)}${EMOJI}y`,
      url: `${"u".repeat(2047)}${EMOJI}z`,
      found_in: `${"f".repeat(2047)}${EMOJI}z`,
    });
    expect(r.label).toBe(`${"x".repeat(199)}${EMOJI}`);
    expect(r.detail).toBe(`${"x".repeat(499)}${EMOJI}`);
    expect(r.url).toBe(`${"u".repeat(2047)}${EMOJI}`);
    expect(r.found_in).toBe(`${"f".repeat(2047)}${EMOJI}`);
  });

  it("leaves nulls and clean values alone", () => {
    expect(sanitizeRow({ ...ROW, label: null, found_in: null })).toEqual({ ...ROW, label: null, found_in: null });
  });
});
