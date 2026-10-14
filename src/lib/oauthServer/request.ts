// The pending-authorization handle. /api/oauth/authorize validates a request,
// signs a short-lived description of it, and sends the browser to the consent
// page with it; /api/oauth/decision re-verifies it before issuing a code.
//
// The handle says *what* is approved (client, redirect, scopes, PKCE
// challenge); the session cookie says *who* approves. Neither alone is
// consent, and the consent page cannot alter the handle.
import "server-only";

import { signPayload, verifyPayload } from "@/lib/oauth/state";
import { knownScopes, type ApiScope } from "@/lib/mcp/scopes";
import { AUTHORIZE_REQUEST_TTL_MS } from "./config";

export interface AuthorizationRequest {
  clientId: string;
  clientName: string;
  /**
   * The host that vouches for the client: the domain serving its Client ID
   * Metadata Document. Null for a DCR client, whose name is self-declared.
   */
  verifiedDomain: string | null;
  redirectUri: string;
  codeChallenge: string;
  scopes: ApiScope[];
  resource: string;
  state?: string;
}

export function encodeAuthorizationRequest(request: AuthorizationRequest): string {
  return signPayload("mcp-authorize", request, AUTHORIZE_REQUEST_TTL_MS);
}

export function decodeAuthorizationRequest(handle: string): AuthorizationRequest | null {
  const parsed = verifyPayload("mcp-authorize", handle);
  if (!parsed) return null;
  const { clientId, clientName, verifiedDomain, redirectUri, codeChallenge, scopes, resource, state } = parsed;
  if (
    typeof clientId !== "string" || typeof clientName !== "string" ||
    typeof redirectUri !== "string" || typeof codeChallenge !== "string" ||
    typeof resource !== "string" || !Array.isArray(scopes) ||
    (verifiedDomain !== null && typeof verifiedDomain !== "string")
  ) {
    return null;
  }
  const known = knownScopes(scopes.filter((s): s is string => typeof s === "string"));
  if (known.length === 0) return null;
  return {
    clientId, clientName, verifiedDomain, redirectUri, codeChallenge, resource,
    scopes: known,
    ...(typeof state === "string" && { state }),
  };
}
