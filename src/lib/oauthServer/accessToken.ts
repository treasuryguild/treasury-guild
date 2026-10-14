// Agent API access tokens: self-contained JWTs, so the resource server checks
// them without a database round trip (the grant is still re-read per request,
// see src/lib/api/caller.ts).
//
// They can never be confused with session JWTs. They are signed with their own
// key (never SUPABASE_JWT_SECRET, so an access token is not a PostgREST or
// session token and a session JWT is not an access token), carry `typ`
// "tg_mcp_at", and are bound to this resource by `aud` (RFC 8707).
import "server-only";

import { randomBytes } from "node:crypto";
import { SignJWT, jwtVerify } from "jose";
import { hmacSha256Hex, sha256Hex } from "@/lib/auth/crypto";
import { cronSecret, mcpTokenSecret } from "@/lib/env.server";
import { parseApiScopes, type ApiScope } from "@/lib/mcp/scopes";
import { ACCESS_TOKEN_TTL_SECONDS, issuerOrigin, resourceUrl } from "./config";

export const ACCESS_TOKEN_TYPE = "tg_mcp_at";
/** RFC 9068 header type of a JWT access token. */
const HEADER_TYPE = "at+jwt";

export interface VerifiedAccessToken {
  wallet: string;
  clientId: string;
  scopes: ApiScope[];
  expiresAt: number;
  /** `created_at` (epoch ms) of the grant the token was issued under. */
  grantCreatedAt: number;
}

/** MCP_TOKEN_SECRET (required in production), else, in dev and tests, a key derived from CRON_SECRET. */
function secret(): Uint8Array {
  const key = mcpTokenSecret() ?? hmacSha256Hex(cronSecret(), "treasury-guild/mcp-access-token");
  return new TextEncoder().encode(key);
}

export async function mintAccessToken(args: {
  wallet: string;
  clientId: string;
  scopes: readonly ApiScope[];
  /** The grant's `created_at` (epoch ms): a token dies with its grant, and a
   *  grant re-created after Disconnect does not revive it. */
  grantCreatedAt: number;
}): Promise<{ token: string; expiresIn: number }> {
  const token = await new SignJWT({
    typ: ACCESS_TOKEN_TYPE,
    cid: args.clientId,
    scope: args.scopes.join(" "),
    gat: args.grantCreatedAt,
  })
    .setProtectedHeader({ alg: "HS256", typ: HEADER_TYPE })
    .setSubject(args.wallet)
    .setIssuer(issuerOrigin())
    .setAudience(resourceUrl())
    .setIssuedAt()
    .setJti(randomBytes(16).toString("hex"))
    .setExpirationTime(`${ACCESS_TOKEN_TTL_SECONDS}s`)
    .sign(secret());
  return { token, expiresIn: ACCESS_TOKEN_TTL_SECONDS };
}

/** The token's claims when it was minted here, for this resource, and is live; else null. */
export async function verifyAccessToken(token: string): Promise<VerifiedAccessToken | null> {
  try {
    const { payload } = await jwtVerify(token, secret(), {
      issuer: issuerOrigin(),
      audience: resourceUrl(),
      typ: HEADER_TYPE,
      algorithms: ["HS256"],
    });
    if (payload.typ !== ACCESS_TOKEN_TYPE) return null;
    if (typeof payload.sub !== "string" || !payload.sub) return null;
    if (typeof payload.cid !== "string" || !payload.cid) return null;
    if (typeof payload.exp !== "number") return null;
    if (typeof payload.gat !== "number") return null;
    return {
      wallet: payload.sub,
      clientId: payload.cid,
      scopes: parseApiScopes(typeof payload.scope === "string" ? payload.scope : ""),
      expiresAt: payload.exp,
      grantCreatedAt: payload.gat,
    };
  } catch {
    return null;
  }
}

/** A random bearer value (authorization code, refresh token, client secret). */
export function generateOpaqueToken(): string {
  return randomBytes(32).toString("base64url");
}

/** How opaque values are stored: never in plaintext. */
export function hashToken(token: string): string {
  return sha256Hex(token);
}
