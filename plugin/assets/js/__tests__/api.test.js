import { describe, expect, it, vi } from "vitest";
import { ApiFailure, SessionExpiredError, createApi } from "../api.js";

const REST = "https://site.test/wp-json/site-guardian/v1/";

function jsonResponse(status, body) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function apiWith(fetchImpl) {
  return createApi({ restUrl: REST, nonce: "n0nce", fetch: fetchImpl });
}

describe("postChat", () => {
  it("posts JSON with the WP nonce and same-origin credentials", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { reply: "hello", conversation_id: "c-1" }));
    const res = await apiWith(fetchImpl).postChat("hi", "c-0");

    expect(res).toEqual({ reply: "hello", conversation_id: "c-1" });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(REST + "chat");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("same-origin");
    expect(init.headers["X-WP-Nonce"]).toBe("n0nce");
    expect(init.headers["Content-Type"]).toBe("application/json");
    expect(JSON.parse(init.body)).toEqual({ message: "hi", conversation_id: "c-0" });
  });

  it("omits conversation_id when there is none", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { reply: "x", conversation_id: "c-1" }));
    await apiWith(fetchImpl).postChat("hi", null);
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toEqual({ message: "hi" });
  });

  it("rejects with SessionExpiredError on 403 rest_cookie_invalid_nonce", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(403, { code: "rest_cookie_invalid_nonce", message: "Cookie check failed", data: { status: 403 } }),
    );
    await expect(apiWith(fetchImpl).postChat("hi", null)).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it("rejects with SessionExpiredError on 401 rest_forbidden", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(401, { code: "rest_forbidden", message: "Sorry", data: { status: 401 } }),
    );
    await expect(apiWith(fetchImpl).postChat("hi", null)).rejects.toBeInstanceOf(SessionExpiredError);
  });

  it("rejects with ApiFailure carrying Core's code and message", async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse(502, {
        error: { code: "ai_unavailable", message: "The assistant is unavailable right now." },
        request_id: "req-1",
      }),
    );
    const err = await apiWith(fetchImpl)
      .postChat("hi", null)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiFailure);
    expect(err.code).toBe("ai_unavailable");
    expect(err.message).toBe("The assistant is unavailable right now.");
    expect(err.status).toBe(502);
    expect(err.requestId).toBe("req-1");
  });

  it("does not treat a Core-shaped 403 as an expired session", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(403, { error: { code: "forbidden", message: "No." } }));
    const err = await apiWith(fetchImpl)
      .postChat("hi", null)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiFailure);
    expect(err.code).toBe("forbidden");
  });

  it("maps a network failure to ApiFailure network_error", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const err = await apiWith(fetchImpl)
      .postChat("hi", null)
      .catch((e) => e);
    expect(err).toBeInstanceOf(ApiFailure);
    expect(err.code).toBe("network_error");
  });

  it("maps a non-JSON or malformed body to ApiFailure bad_response", async () => {
    const html = vi.fn(async () => new Response("<html>oops</html>", { status: 500 }));
    const e1 = await apiWith(html)
      .postChat("hi", null)
      .catch((e) => e);
    expect(e1).toBeInstanceOf(ApiFailure);
    expect(e1.code).toBe("bad_response");

    const noReply = vi.fn(async () => jsonResponse(200, { nope: true }));
    const e2 = await apiWith(noReply)
      .postChat("hi", null)
      .catch((e) => e);
    expect(e2).toBeInstanceOf(ApiFailure);
    expect(e2.code).toBe("bad_response");
  });
});

describe("getConversation", () => {
  it("returns the stored conversation id", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { conversation_id: "c-9" }));
    await expect(apiWith(fetchImpl).getConversation()).resolves.toBe("c-9");
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(REST + "conversation");
    expect(init.method).toBe("GET");
    expect(init.headers["X-WP-Nonce"]).toBe("n0nce");
  });

  it("returns null when there is none", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse(200, { conversation_id: null }));
    await expect(apiWith(fetchImpl).getConversation()).resolves.toBeNull();
  });
});
