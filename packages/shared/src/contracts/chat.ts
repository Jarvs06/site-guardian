import { z } from "zod";

export const ChatRequest = z
  .object({
    message: z.string().min(1).max(4000),
    conversation_id: z.uuid().optional(),
  })
  .strict();
export type ChatRequest = z.infer<typeof ChatRequest>;

export const ChatResponse = z
  .object({
    reply: z.string(),
    conversation_id: z.uuid(),
  })
  .strict();
export type ChatResponse = z.infer<typeof ChatResponse>;
