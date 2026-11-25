import { describe, expect, it } from "vitest";
import { toCsv } from "../csv.js";

function row(over = {}) {
  return {
    id: "1",
    kind: "link",
    url: "https://site.test/a",
    label: "A",
    source: "page",
    found_in: "https://site.test/",
    found_count: 1,
    status: "broken",
    http_code: 404,
    detail: "Page not found",
    robots_index: null,
    robots_follow: null,
    ...over,
  };
}

describe("toCsv", () => {
  it("starts with a UTF-8 BOM and the quoted header row, CRLF-separated", () => {
    const csv = toCsv([row()]);
    expect(csv.startsWith("﻿")).toBe(true);
    const lines = csv.slice(1).split("\r\n");
    expect(lines[0]).toBe('"URL","Source","Found In","Index","Follow","Status","HTTP Code","Detail"');
    expect(lines[1]).toBe(
      '"https://site.test/a","page","https://site.test/","N/A","N/A","broken","404","Page not found"',
    );
    expect(lines).toHaveLength(2);
  });

  it("writes robots values and empty cells for nulls", () => {
    const csv = toCsv([
      row({ kind: "page", source: "post", found_in: null, robots_index: "noindex", robots_follow: "follow", http_code: null, detail: null, status: "ok" }),
    ]);
    expect(csv.split("\r\n")[1]).toBe('"https://site.test/a","post","","noindex","follow","ok","",""');
  });

  it("neutralizes formula-looking cells and doubles quotes", () => {
    const csv = toCsv([
      row({ url: "=SUM(A1)", source: "+x", found_in: "-1", detail: 'say "hi"', label: null }),
      row({ url: "@cmd" }),
    ]);
    const lines = csv.split("\r\n");
    expect(lines[1]).toBe(`"'=SUM(A1)","'+x","'-1","N/A","N/A","broken","404","say ""hi"""`);
    expect(lines[2].startsWith(`"'@cmd",`)).toBe(true);
  });

  it("writes only the header for no rows", () => {
    expect(toCsv([])).toBe('﻿"URL","Source","Found In","Index","Follow","Status","HTTP Code","Detail"');
  });
});
