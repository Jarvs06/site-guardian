import { SafeFetchError } from "@sg/shared";
import { describe, expect, it } from "vitest";
import { classifyError, classifyResponse } from "./classify.js";

const r = (status: number, requestedUrl = "https://ex.com/a", finalUrl = requestedUrl) =>
  classifyResponse({ requestedUrl, finalUrl, status });

describe("classifyResponse", () => {
  it("200 same url is ok", () => {
    expect(r(200)).toEqual({ status: "ok", httpCode: 200, detail: null });
  });
  it("accepts a trailing-slash difference", () => {
    expect(r(200, "https://ex.com/a", "https://ex.com/a/").status).toBe("ok");
  });
  it("accepts http to https on the same path", () => {
    expect(r(200, "http://ex.com/a", "https://ex.com/a").status).toBe("ok");
  });
  it("different final url is redirect", () => {
    expect(r(200, "https://ex.com/a", "https://ex.com/b")).toEqual({
      status: "redirect",
      httpCode: 200,
      detail: "Redirects to https://ex.com/b",
    });
  });
  it("different query is a redirect", () => {
    expect(r(200, "https://ex.com/a?x=1", "https://ex.com/a").status).toBe("redirect");
  });
  it("404 and 410", () => {
    expect(r(404)).toEqual({ status: "broken", httpCode: 404, detail: "Page not found (404)" });
    expect(r(410)).toEqual({ status: "broken", httpCode: 410, detail: "Gone (410)" });
  });
  it("other 4xx is broken", () => {
    expect(r(400)).toEqual({ status: "broken", httpCode: 400, detail: "Client error (400)" });
    expect(r(451).status).toBe("broken");
  });
  it("401 and 403 are restricted", () => {
    expect(r(401)).toEqual({ status: "restricted", httpCode: 401, detail: "Access restricted (401)" });
    expect(r(403).status).toBe("restricted");
  });
  it("429 is a rate-limit warning", () => {
    expect(r(429)).toEqual({ status: "warning", httpCode: 429, detail: "Rate limited (429)" });
  });
  it("5xx is a warning", () => {
    expect(r(503)).toEqual({ status: "warning", httpCode: 503, detail: "Server error (503)" });
  });
});

describe("classifyError", () => {
  const e = (code: ConstructorParameters<typeof SafeFetchError>[0], cause?: unknown) =>
    classifyError(new SafeFetchError(code, "boom", cause ? { cause } : undefined));
  it("maps each code", () => {
    expect(e("dns_failed")).toEqual({ status: "broken", httpCode: null, detail: "Couldn't find this website (DNS)" });
    expect(e("timeout")).toEqual({ status: "warning", httpCode: null, detail: "Timed out" });
    expect(e("too_many_redirects")).toEqual({ status: "warning", httpCode: null, detail: "Too many redirects" });
    expect(e("blocked_address")).toEqual({
      status: "skipped",
      httpCode: null,
      detail: "Not checked: points to a private network address",
    });
    expect(e("bad_port")).toEqual({ status: "skipped", httpCode: null, detail: "Not checked: port not allowed" });
    expect(e("invalid_url")).toEqual({ status: "skipped", httpCode: null, detail: "Invalid link" });
    expect(e("bad_scheme")).toEqual({ status: "skipped", httpCode: null, detail: "Invalid link" });
  });
  it("network_error by cause", () => {
    expect(e("network_error", { code: "ECONNREFUSED" })).toEqual({
      status: "broken",
      httpCode: null,
      detail: "Connection refused",
    });
    for (const code of ["ERR_TLS_CERT_ALTNAME_INVALID", "CERT_HAS_EXPIRED", "DEPTH_ZERO_SELF_SIGNED_CERT", "UNABLE_TO_VERIFY_LEAF_SIGNATURE"]) {
      expect(e("network_error", { code })).toEqual({ status: "warning", httpCode: null, detail: "Secure connection failed" });
    }
    expect(e("network_error", { code: "ECONNRESET" })).toEqual({ status: "warning", httpCode: null, detail: "Connection failed" });
    expect(e("network_error")).toEqual({ status: "warning", httpCode: null, detail: "Connection failed" });
  });
  it("plain errors never leak their message", () => {
    expect(classifyError(new Error("secret internals"))).toEqual({ status: "warning", httpCode: null, detail: "Connection failed" });
  });
});
