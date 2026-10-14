import "server-only";

import { cookies } from "next/headers";
import { UnauthorizedError } from "@/lib/errors";
import { SESSION_COOKIE, verifySessionJwt, type SessionClaims } from "./jwt";

export { UnauthorizedError };

/** The authenticated wallet session, or null. */
export async function getSession(): Promise<SessionClaims | null> {
  const store = await cookies();
  const token = store.get(SESSION_COOKIE)?.value;
  if (!token) return null;
  return verifySessionJwt(token);
}

/**
 * The raw, *unverified* session cookie value. Only for callers that have
 * already verified the session this request (e.g. inside publicRoute/
 * sessionRoute handlers), to avoid a second jwtVerify.
 */
export async function getSessionCookie(): Promise<string | null> {
  const store = await cookies();
  return store.get(SESSION_COOKIE)?.value ?? null;
}

/** The verified raw session JWT (for RLS-scoped Supabase clients), or null. */
export async function getSessionToken(): Promise<string | null> {
  const token = await getSessionCookie();
  if (!token) return null;
  return (await verifySessionJwt(token)) ? token : null;
}

export async function requireSession(): Promise<SessionClaims> {
  const session = await getSession();
  if (!session) throw new UnauthorizedError();
  return session;
}
