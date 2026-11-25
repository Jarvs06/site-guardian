import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/** Service-role client. Core is the only component that talks to the database. */
export function createSupabase(url: string, serviceRoleKey: string): SupabaseClient {
  return createClient(url, serviceRoleKey, { auth: { persistSession: false, autoRefreshToken: false } });
}
