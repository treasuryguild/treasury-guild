import "server-only";

import { SignJWT, jwtVerify } from "jose";
import { supabaseJwtSecret } from "@/lib/env.server";

const COOKIE_NAME = "gv_session";
const SESSION_DAYS = 7;

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
 * address, never a UUID — auth.uid() must not be used).
 */
export async function mintSessionJwt(wallet: string): Promise<string> {
  return mintJwt(wallet, `${SESSION_DAYS}d`);
}

/**
 * The same claims with a short life, for the browser Supabase client. The
 * cookie never reaches JavaScript, so a token taken by injected script stops
 * working within minutes instead of lasting the session's seven days.
 */
export async function mintAccessJwt(wallet: string): Promise<string> {
  return mintJwt(wallet, `${ACCESS_TOKEN_MINUTES}m`);
}

async function mintJwt(wallet: string, expiresIn: string): Promise<string> {
  return new SignJWT({
    wallet,
    role: "authenticated",
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
    });
    const wallet = payload.wallet;
    if (typeof wallet !== "string" || !wallet) return null;
    return { wallet };
  } catch {
    return null;
  }
}

export const SESSION_COOKIE = COOKIE_NAME;
export const SESSION_MAX_AGE_SECONDS = SESSION_DAYS * 24 * 60 * 60;
