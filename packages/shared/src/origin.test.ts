import { describe, expect, it } from "vitest";
import { InvalidOriginError, normalizeOrigin } from "./origin.js";

describe("normalizeOrigin", () => {
  it("drops default ports, path, and lowercases", () => {
    expect(normalizeOrigin("https://Example.COM:443/blog/")).toBe("https://example.com");
    expect(normalizeOrigin("http://example.com:80")).toBe("http://example.com");
  });
  it("strips trailing dot and keeps non-default ports", () => {
    expect(normalizeOrigin("https://example.com.")).toBe("https://example.com");
    expect(normalizeOrigin("https://example.com:8443")).toBe("https://example.com:8443");
  });
  it("converts IDN to punycode and drops query/fragment", () => {
    expect(normalizeOrigin("https://bücher.de")).toBe("https://xn--bcher-kva.de");
    expect(normalizeOrigin("https://example.com/a?b=1#c")).toBe("https://example.com");
  });
  it("rejects non-http(s), credentials, unparsable and empty-host URLs", () => {
    expect(() => normalizeOrigin("ftp://example.com")).toThrow(InvalidOriginError);
    expect(() => normalizeOrigin("https://u:p@example.com")).toThrow(InvalidOriginError);
    expect(() => normalizeOrigin("https://u@example.com")).toThrow(InvalidOriginError);
    expect(() => normalizeOrigin("not a url")).toThrow(InvalidOriginError);
    expect(() => normalizeOrigin("http://")).toThrow(InvalidOriginError);
  });
  it("rejects IP literals unless allowed", () => {
    expect(() => normalizeOrigin("http://127.0.0.1")).toThrow(InvalidOriginError);
    expect(() => normalizeOrigin("http://[::1]")).toThrow(InvalidOriginError);
    expect(normalizeOrigin("http://127.0.0.1:8080", { allowIpHosts: true })).toBe("http://127.0.0.1:8080");
    expect(normalizeOrigin("http://[::1]:8080", { allowIpHosts: true })).toBe("http://[::1]:8080");
  });
});
