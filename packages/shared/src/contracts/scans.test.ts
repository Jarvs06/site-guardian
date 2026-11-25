import { describe, expect, it } from "vitest";
import { ScanPagesRequest, ScanStatus } from "./scans.js";

const page = { url: "https://ex.com/a", source: "post" };
const pages = (n: number) => Array.from({ length: n }, () => page);

describe("ScanPagesRequest", () => {
  it("accepts 500 pages", () => {
    expect(ScanPagesRequest.safeParse({ pages: pages(500), pages_found: 900 }).success).toBe(true);
  });
  it.each([0, 501])("rejects %i pages", (n) => {
    expect(ScanPagesRequest.safeParse({ pages: pages(n) }).success).toBe(false);
  });
  it("rejects extra keys and negative pages_found", () => {
    expect(ScanPagesRequest.safeParse({ pages: pages(1), x: 1 }).success).toBe(false);
    expect(ScanPagesRequest.safeParse({ pages: pages(1), pages_found: -1 }).success).toBe(false);
  });
});

describe("ScanStatus", () => {
  it("parses a full example", () => {
    const id = "6f1c1e0a-3b0e-4c53-8d0e-0e4d3f6a9b11";
    expect(
      ScanStatus.safeParse({
        scan_id: id, type: "link", status: "completed",
        pages_total: 10, pages_checked: 10, links_total: 50, links_checked: 50,
        pages_submitted: 10, pages_found: null, truncated_reason: "time_limit", results_scan_id: id,
        counts: { ok: 40, broken: 2, redirect: 3, restricted: 1, warning: 2, skipped: 2, indexed: 8, noindex: 1, nofollow: 1 },
        created_at: "2026-11-25T00:00:00Z", started_at: "2026-11-25T00:00:05Z",
        completed_at: "2026-11-25T00:10:00Z", error: null,
      }).success,
    ).toBe(true);
  });
});
