import Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it, vi } from "vitest";
import { createAnthropicAi } from "./ai.js";
import { ApiError } from "./errors.js";

const config = { ANTHROPIC_API_KEY: "k", ANTHROPIC_MODEL: "claude-opus-5-5" };
const input = { system: "sys", messages: [{ role: "user" as const, content: "hi" }] };

function aiWith(create: (body: Record<string, unknown>) => unknown) {
  const spy = vi.fn(create);
  const ai = createAnthropicAi(config, () => ({ beta: { messages: { create: spy } } }));
  return { ai, spy };
}
const msg = (stop_reason: string, content: unknown[]) => ({ stop_reason, content });

describe("createAnthropicAi", () => {
  it("sends the required request shape and no rejected params", async () => {
    const { ai, spy } = aiWith(() => msg("end_turn", [{ type: "text", text: "yo" }]));
    await ai.reply(input);
    const body = spy.mock.calls[0]![0];
    expect(body).toMatchObject({
      model: "claude-opus-5-5",
      max_tokens: 16000,
      system: "sys",
      output_config: { effort: "low" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
    for (const k of ["temperature", "top_p", "top_k", "thinking"]) expect(body).not.toHaveProperty(k);
  });

  it("joins text blocks and ignores thinking blocks", async () => {
    const { ai } = aiWith(() =>
      msg("end_turn", [
        { type: "thinking", thinking: "secret", signature: "s" },
        { type: "text", text: "Hello " },
        { type: "text", text: "there" },
      ]),
    );
    await expect(ai.reply(input)).resolves.toBe("Hello there");
  });

  it("throws aiUnavailable on refusal with no text", async () => {
    const { ai } = aiWith(() => msg("refusal", [{ type: "thinking", thinking: "x", signature: "s" }]));
    await expect(ai.reply(input)).rejects.toMatchObject({ code: "ai_unavailable" });
  });

  it("throws aiUnavailable when the reply has no text at all", async () => {
    const { ai } = aiWith(() => msg("end_turn", []));
    await expect(ai.reply(input)).rejects.toBeInstanceOf(ApiError);
  });

  it.each([
    ["rate limit", () => new Anthropic.RateLimitError(429, {}, "x", new Headers())],
    ["connection", () => new Anthropic.APIConnectionError({ message: "down" })],
    ["timeout", () => new Anthropic.APIConnectionTimeoutError()],
    ["5xx", () => new Anthropic.InternalServerError(500, {}, "x", new Headers())],
    ["auth", () => new Anthropic.AuthenticationError(401, {}, "x", new Headers())],
    ["bad request", () => new Anthropic.BadRequestError(400, {}, "x", new Headers())],
  ])("maps %s errors to aiUnavailable without leaking", async (_n, mk) => {
    const { ai } = aiWith(() => {
      throw mk();
    });
    await expect(ai.reply(input)).rejects.toMatchObject({ code: "ai_unavailable", message: expect.not.stringContaining("x") as unknown });
  });

  it("rethrows unknown errors", async () => {
    const boom = new Error("boom");
    const { ai } = aiWith(() => {
      throw boom;
    });
    await expect(ai.reply(input)).rejects.toBe(boom);
  });
});
