import Anthropic from "@anthropic-ai/sdk";
import type { Config } from "../config.js";
import type { Logger } from "./logger.js";
import { ApiError } from "./errors.js";

export interface AiClient {
  reply(input: { system: string; messages: Anthropic.MessageParam[] }): Promise<string>;
}

/** The slice of the SDK client we use; tests inject a fake. */
export interface AnthropicLike {
  beta: { messages: { create(body: never): PromiseLike<unknown> } };
}

type AiConfig = Pick<Config, "ANTHROPIC_API_KEY" | "ANTHROPIC_MODEL">;

interface ReplyShape {
  stop_reason?: string | null;
  content?: { type: string; text?: string }[];
}

export function createAnthropicAi(
  config: AiConfig,
  makeClient: (apiKey: string) => AnthropicLike = (apiKey) =>
    new Anthropic({ apiKey, timeout: 60_000, maxRetries: 2 }) as unknown as AnthropicLike,
  log?: Logger,
): AiClient {
  const client = makeClient(config.ANTHROPIC_API_KEY ?? "");
  return {
    async reply({ system, messages }) {
      let res: ReplyShape;
      try {
        // No temperature/top_p/top_k, thinking config, or assistant prefill: the model rejects them.
        const body: Anthropic.Beta.Messages.MessageCreateParamsNonStreaming = {
          model: config.ANTHROPIC_MODEL,
          max_tokens: 16000,
          system,
          messages,
          output_config: { effort: "low" },
          betas: ["server-side-fallback-2026-07-01"],
          fallbacks: "default",
        };
        res = (await client.beta.messages.create(body as never)) as ReplyShape;
      } catch (err) {
        throw mapError(err, log);
      }
      // Check stop_reason before reading content.
      const text = (res.content ?? [])
        .filter((b) => b.type === "text")
        .map((b) => b.text ?? "")
        .join("");
      if (res.stop_reason === "refusal" && text === "") throw ApiError.aiUnavailable();
      if (text.trim() === "") throw ApiError.aiUnavailable();
      return text;
    },
  };
}

/** Most specific first. Upstream messages are never surfaced to the caller. */
function mapError(err: unknown, log?: Logger): unknown {
  if (err instanceof ApiError) return err;
  if (err instanceof Anthropic.RateLimitError) return ApiError.aiUnavailable();
  if (err instanceof Anthropic.APIConnectionError) return ApiError.aiUnavailable(); // includes timeouts
  if (err instanceof Anthropic.InternalServerError) return ApiError.aiUnavailable();
  if (err instanceof Anthropic.APIError && typeof err.status === "number" && err.status >= 500) {
    return ApiError.aiUnavailable();
  }
  if (err instanceof Anthropic.AuthenticationError || err instanceof Anthropic.BadRequestError) {
    // Misconfiguration on our side (bad key / bad request): page someone, tell the user nothing.
    log?.error({ status: err.status, name: err.name }, "anthropic request rejected");
    return ApiError.aiUnavailable();
  }
  return err;
}
