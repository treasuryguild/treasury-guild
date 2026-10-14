// Service-role client: bypasses RLS. Only for server routes that have already
// authorized the caller in code (tx lifecycle, webhooks, cron).
import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { supabaseServiceRoleKey, supabaseUrl } from "@/lib/env.server";

let client: SupabaseClient | undefined;

export function serviceClient(): SupabaseClient {
  if (!client) {
    client = createClient(supabaseUrl(), supabaseServiceRoleKey(), {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}
