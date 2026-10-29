import "server-only";

import { SignJWT, jwtVerify } from "jose";
import { isProduction, supabaseJwtSecret } from "@/lib/env.server";

const SESSION_DAYS = 7;

/** Distinguishes the httpOnly session cookie from the short-lived RLS access token. */
export const JwtKind = {
  Session: "session",
  Rls: "rls",
} as const;
export type JwtKind = (typeof JwtKind)[keyof typeof JwtKind];

export interface SessionClaims {
  /** Bech32 payment address of the authenticated wallet */
  wallet: string;
}

function secret(): Uint8Array {
  return new TextEncoder().encode(supabaseJwtSecret());
}

/** How long a browser access token lives (/api/auth/token). */
export const ACCESS_TOKEN_MINUTES = 15;

/**
 * Mint the session JWT (the httpOnly cookie). Signed with the Supabase JWT
 * secret and shaped so Supabase RLS accepts it as an authenticated request:
 * policies read the `wallet` claim via jwt_wallet() (sub is a bech32
 * address, never a UUID — auth.uid() must not be used). Carries
 * `kind: "session"` so a leaked short-lived access token cannot be replayed
 * as the cookie.
 */
export async function mintSessionJwt(wallet: string): Promise<string> {
  return mintJwt(wallet, `${SESSION_DAYS}d`, JwtKind.Session);
}

/**
 * The same wallet claims with a short life, for the browser Supabase client.
 * The cookie never reaches JavaScript, so a token taken by injected script
 * stops working within minutes instead of lasting the session's seven days.
 * Carries `kind: "rls"` and is refused by verifySessionJwt.
 */
export async function mintAccessJwt(wallet: string): Promise<string> {
  return mintJwt(wallet, `${ACCESS_TOKEN_MINUTES}m`, JwtKind.Rls);
}

async function mintJwt(wallet: string, expiresIn: string, kind: JwtKind): Promise<string> {
  return new SignJWT({
    wallet,
    role: "authenticated",
    kind,
  })
    .setProtectedHeader({ alg: "HS256" })
    .setSubject(wallet)
    .setAudience("authenticated")
    .setIssuer("treasury-guild")
    .setIssuedAt()
    .setExpirationTime(expiresIn)
    .sign(secret());
}

export async function verifySessionJwt(
  token: string,
): Promise<SessionClaims | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), {
      audience: "authenticated",
      issuer: "treasury-guild",
      algorithms: ["HS256"],
    });
    // Reject short-lived RLS tokens and legacy cookies that lack `kind`
    // once every session has been re-minted; accept missing kind only as
    // a one-release bridge would, but we require session so stolen
    // /api/auth/token bytes cannot become a cookie.
    if (payload.kind !== JwtKind.Session) return null;
    const wallet = payload.wallet;
    if (typeof wallet !== "string" || !wallet) return null;
    return { wallet };
  } catch {
    return null;
  }
}

/** Production uses `__Host-` so a sibling subdomain cannot plant a session cookie. */
export const SESSION_COOKIE = isProduction() ? "__Host-tg_session" : "tg_session";
export const SESSION_MAX_AGE_SECONDS = SESSION_DAYS * 24 * 60 * 60;
