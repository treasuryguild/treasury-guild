// Who is calling the agent API (/api/mcp and /api/v1), resolved once per
// request: an OAuth access token from src/lib/oauthServer, or (REST only) the
// session cookie.
import "server-only";

import { getSession } from "@/lib/auth/session";
import { findOAuthGrant, touchOAuthGrant } from "@/lib/db/oauth";
import { ForbiddenError, UnauthorizedError } from "@/lib/errors";
import { API_SCOPES, knownScopes, type ApiScope } from "@/lib/mcp/scopes";
import { verifyAccessToken } from "@/lib/oauthServer/accessToken";

export interface ApiCaller {
  /** Bech32 payment address the request acts as. */
  wallet: string;
  scopes: ApiScope[];
  /** The OAuth client, or null for the app's own session. */
  clientId: string | null;
  via: "session" | "oauth";
  /** `created_at` (epoch ms) of the OAuth grant behind the token; absent for the session. */
  grantCreatedAt?: number;
}

/** The Bearer credential of the request, or null when it sends none. */
export function bearerToken(req: Request): string | null {
  const header = req.headers.get("authorization");
  if (!header || !/^bearer /i.test(header)) return null;
  return header.slice(7).trim() || null;
}

/**
 * The caller behind an access token, or null. The stored grant is
 * authoritative, not the token: a connection removed on the Settings page, or
 * a scope taken away, stops working on the very next request instead of when
 * the hour-long token expires. Scopes are the intersection of both, so a
 * token never gains reach it was not issued with.
 */
export async function callerFromAccessToken(token: string): Promise<ApiCaller | null> {
  const claims = await verifyAccessToken(token);
  if (!claims) return null;
  const grant = await findOAuthGrant(claims.wallet, claims.clientId);
  if (!grant) return null;
  // Issued under this very grant: after Disconnect (or a detected leak, which
  // deletes the grant) and a later re-approval, older tokens stay dead.
  if (claims.grantCreatedAt !== Date.parse(grant.created_at)) return null;
  const granted = knownScopes(grant.scopes);
  const scopes = claims.scopes.filter((s) => granted.includes(s));
  if (scopes.length === 0) return null;
  // Best effort: a failed stamp must not fail the request.
  void touchOAuthGrant(grant).catch((err: unknown) => console.error("touch oauth grant failed", err));
  return { wallet: claims.wallet, scopes, clientId: claims.clientId, via: "oauth", grantCreatedAt: claims.grantCreatedAt };
}

/**
 * Resolve the caller; 401 otherwise. A request that presents a Bearer
 * credential is judged on it alone (an invalid token never falls back to the
 * cookie). The session cookie counts only where `allowSession` says so: the
 * REST routes accept it with every scope, since it can already do everything
 * the app does; /api/mcp never does.
 */
export async function resolveApiCaller(
  req: Request,
  { allowSession }: { allowSession: boolean },
): Promise<ApiCaller> {
  const token = bearerToken(req);
  if (token) {
    const caller = await callerFromAccessToken(token);
    if (!caller) throw new UnauthorizedError("Invalid or expired access token");
    return caller;
  }
  if (allowSession) {
    const session = await getSession();
    if (session) return { wallet: session.wallet, scopes: [...API_SCOPES], clientId: null, via: "session" };
  }
  throw new UnauthorizedError();
}

export function requireScope(caller: ApiCaller, scope: ApiScope): void {
  if (!caller.scopes.includes(scope)) {
    throw new ForbiddenError(`This connection was not granted the ${scope} permission`);
  }
}
