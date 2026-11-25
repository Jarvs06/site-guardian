import type { SupabaseClient } from "@supabase/supabase-js";
import type { Logger } from "./logger.js";

export interface AuditEntry {
  website_id?: string;
  wp_user_ref?: string;
  action: string;
  metadata?: object;
  ip?: string;
}

/** Writes an audit_logs row. Never throws: failures are logged only. */
export async function audit(deps: { supabase: SupabaseClient; log?: Logger }, entry: AuditEntry): Promise<void> {
  try {
    const { error } = await deps.supabase.from("audit_logs").insert({
      website_id: entry.website_id ?? null,
      wp_user_ref: entry.wp_user_ref ?? null,
      actor: entry.website_id ? `website:${entry.website_id}` : "system",
      action: entry.action,
      metadata: entry.metadata ?? {},
      ip_address: entry.ip ?? null,
    });
    if (error) deps.log?.error({ err: error.message, action: entry.action }, "audit write failed");
  } catch (err) {
    deps.log?.error({ err, action: entry.action }, "audit write threw");
  }
}
