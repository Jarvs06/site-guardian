import type Anthropic from "@anthropic-ai/sdk";

export interface AiClient {
  reply(input: { system: string; messages: Anthropic.MessageParam[] }): Promise<string>;
}
