import { z } from "zod";

export const ConfigResponse = z
  .object({
    config: z.record(z.string(), z.unknown()),
    website: z.object({ id: z.uuid(), status: z.string() }).strict(),
  })
  .strict();
export type ConfigResponse = z.infer<typeof ConfigResponse>;
