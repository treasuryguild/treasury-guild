"use client";

// Browser client: hands the session JWT to supabase-js so RLS sees the wallet
// claim. Falls back to anon when logged out.
//
// supabase-js calls `accessToken()` before *every* query, so the token is
// cached here. SessionProvider seeds it from its own /api/auth/token call
// (setBrowserToken); the fetch below is only the fallback for a cold cache.
import { createClient, type SupabaseClient } from "@supabase/supabase-js";

const EXPIRY_MARGIN_MS = 60_000;

interface CachedToken {
  token: string | null;
  /** Epoch ms after which the token is considered stale. */
  staleAt: number;
}

let client: SupabaseClient | undefined;
let cached: CachedToken | null = null;
let inflight: Promise<string | null> | null = null;

/** `exp` of an unverified JWT as epoch ms, or 0 when unreadable. */
function jwtExpiryMs(token: string): number {
  try {
    const payload = token.split(".")[1] ?? "";
    const json = atob(payload.replace(/-/g, "+").replace(/_/g, "/"));
    const exp = (JSON.parse(json) as { exp?: unknown }).exp;
    return typeof exp === "number" ? exp * 1000 : 0;
  } catch {
    return 0;
  }
}

function remember(token: string | null): void {
  cached = {
    token,
    // A null token (logged out) stays valid until the session changes it.
    staleAt: token ? jwtExpiryMs(token) - EXPIRY_MARGIN_MS : Number.POSITIVE_INFINITY,
  };
}

/** Seed (or reset, with null) the token the browser Supabase client uses. */
export function setBrowserToken(token: string | null): void {
  remember(token);
  inflight = null;
}

/** Drop the cache so the next query re-fetches the token. */
export function clearBrowserToken(): void {
  cached = null;
  inflight = null;
}

async function fetchToken(): Promise<string | null> {
  try {
    const res = await fetch("/api/auth/token");
    if (!res.ok) return null;
    const { token } = (await res.json()) as { token: string | null };
    remember(token);
    return token;
  } catch {
    return null;
  }
}

function accessToken(): Promise<string | null> {
  if (cached && Date.now() < cached.staleAt) return Promise.resolve(cached.token);
  if (!inflight) {
    inflight = fetchToken().finally(() => {
      inflight = null;
    });
  }
  return inflight;
}

export function browserClient(): SupabaseClient {
  if (!client) {
    client = createClient(
      process.env.NEXT_PUBLIC_SUPABASE_URL!,
      process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY!,
      {
        auth: { persistSession: false, autoRefreshToken: false },
        accessToken,
      },
    );
  }
  return client;
}
