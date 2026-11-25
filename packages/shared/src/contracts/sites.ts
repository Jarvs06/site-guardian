import { z } from "zod";

export const RegisterStartRequest = z
  .object({
    installation_id: z.uuid(),
    site_url: z.url().max(2048),
    site_name: z.string().max(255).optional(),
    wp_version: z.string().max(32).optional(),
    plugin_version: z.string().max(32).optional(),
    php_version: z.string().max(32).optional(),
  })
  .strict();
export type RegisterStartRequest = z.infer<typeof RegisterStartRequest>;

export const RegisterStartResponse = z
  .object({
    challenge_id: z.uuid(),
    challenge: z.string(),
    expires_at: z.iso.datetime(),
  })
  .strict();
export type RegisterStartResponse = z.infer<typeof RegisterStartResponse>;

export const RegisterCompleteRequest = z.object({ challenge_id: z.uuid() }).strict();
export type RegisterCompleteRequest = z.infer<typeof RegisterCompleteRequest>;

export const RegisterCompleteResponse = z
  .object({
    website_id: z.uuid(),
    credential: z.string(),
    plan_code: z.string(),
  })
  .strict();
export type RegisterCompleteResponse = z.infer<typeof RegisterCompleteResponse>;

export const RotateResponse = z.object({ credential: z.string() }).strict();
export type RotateResponse = z.infer<typeof RotateResponse>;
