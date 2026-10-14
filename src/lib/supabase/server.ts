// RLS-scoped client for server components and route handlers: passes the
// caller's session JWT so policies see the wallet claim.
import "server-only";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { getSessionToken } from "@/lib/auth/session";
import { supabaseAnonKey, supabaseUrl } from "@/lib/env.server";

export async function serverClient(): Promise<SupabaseClient> {
  const token = await getSessionToken();
  return createClient(supabaseUrl(), supabaseAnonKey(), {
    auth: { persistSession: false, autoRefreshToken: false },
    ...(token
      ? { global: { headers: { Authorization: `Bearer ${token}` } } }
      : {}),
  });
}
