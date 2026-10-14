// Validation of an OAuth authorization request (GET /api/oauth/authorize),
// kept pure so every refusal is unit-tested. The route resolves the client,
// then this decides between three outcomes:
//
//  - `render`: nothing about the request can be trusted yet (unknown client,
//    unregistered redirect_uri). It is shown to the user and NEVER redirected
//    to: an open redirect would hand authorization codes to an attacker.
//  - `bounce`: the redirect target is registered, so the error goes back to
//    the client there (RFC 6749 §4.1.2.1), with `iss` (RFC 9207).
//  - `ok`: the validated request, to sign into the consent handle.

import type { OAuthClientRow } from "@/lib/db/types";
import { API_SCOPES, parseApiScopes, READ_SCOPES, type ApiScope } from "@/lib/mcp/scopes";
import type { ConsentErrorCode } from "./consentErrors";
import { isValidCodeChallenge } from "./pkce";
import { findMatchingRedirectUri, isAcceptableRedirectUri } from "./redirects";
import type { AuthorizationRequest } from "./request";

export interface AuthorizeParams {
  clientId: string | null;
  redirectUri: string | null;
  responseType: string | null;
  codeChallenge: string | null;
  codeChallengeMethod: string | null;
  scope: string | null;
  state: string | null;
  resource: string | null;
}

export type AuthorizeOutcome =
  | { kind: "ok"; request: AuthorizationRequest }
  | { kind: "render"; error: ConsentErrorCode; description: string }
  | { kind: "bounce"; redirectUri: string; error: string; description: string; state: string | null };

export function authorizeParams(url: URL): AuthorizeParams {
  const get = (key: string) => url.searchParams.get(key);
  return {
    clientId: get("client_id"),
    redirectUri: get("redirect_uri"),
    responseType: get("response_type"),
    codeChallenge: get("code_challenge"),
    codeChallengeMethod: get("code_challenge_method"),
    scope: get("scope"),
    state: get("state"),
    resource: get("resource"),
  };
}

/**
 * The scopes to ask the user for. A request naming none gets every read
 * scope (a write scope only when named); unknown names are dropped, and a
 * request left with nothing is refused rather than widened.
 */
export function requestedScopes(scope: string | null): ApiScope[] {
  if (!scope || !scope.trim()) return [...READ_SCOPES];
  return parseApiScopes(scope);
}

export function validateAuthorizeRequest(
  params: AuthorizeParams,
  client: Pick<OAuthClientRow, "client_id" | "client_name" | "redirect_uris" | "is_metadata_url"> | null,
  resource: string,
): AuthorizeOutcome {
  if (!params.clientId || !params.redirectUri) {
    return { kind: "render", error: "invalid_request", description: "client_id and redirect_uri are required" };
  }
  if (!client) {
    return { kind: "render", error: "invalid_client", description: "Unknown or unresolvable client_id" };
  }
  const redirectUri = findMatchingRedirectUri(client.redirect_uris, params.redirectUri);
  if (!redirectUri) {
    return { kind: "render", error: "unregistered_redirect", description: "redirect_uri is not registered for this client" };
  }
  // Registration already filters schemes; this is the last check before the
  // value is signed into the handle and later handed to the browser.
  if (!isAcceptableRedirectUri(redirectUri)) {
    return { kind: "render", error: "bad_redirect_scheme", description: "redirect_uri scheme is not permitted" };
  }

  const bounce = (error: string, description: string): AuthorizeOutcome =>
    ({ kind: "bounce", redirectUri, error, description, state: params.state });

  if (params.responseType !== "code") {
    return bounce("unsupported_response_type", "Only response_type=code is supported");
  }
  if (!params.codeChallenge || !isValidCodeChallenge(params.codeChallenge)) {
    return bounce("invalid_request", "A valid S256 code_challenge is required");
  }
  if (params.codeChallengeMethod !== "S256") {
    return bounce("invalid_request", "code_challenge_method must be S256");
  }
  const scopes = requestedScopes(params.scope);
  if (scopes.length === 0) {
    return bounce("invalid_scope", `Supported scopes: ${API_SCOPES.join(" ")}`);
  }
  // RFC 8707: a named resource must be this server, or the token would carry
  // an audience nobody here accepts.
  if (params.resource && params.resource.replace(/\/+$/, "") !== resource) {
    return bounce("invalid_target", `Unknown resource. Expected ${resource}`);
  }

  return {
    kind: "ok",
    request: {
      clientId: client.client_id,
      clientName: client.client_name,
      verifiedDomain: client.is_metadata_url ? new URL(client.client_id).host : null,
      redirectUri,
      codeChallenge: params.codeChallenge,
      scopes,
      resource,
      ...(params.state ? { state: params.state } : {}),
    },
  };
}

/** The client's redirect target carrying an authorization response (code or error). */
export function authorizationResponseUrl(
  redirectUri: string,
  issuer: string,
  fields: { code?: string; error?: string; description?: string; state?: string | null },
): string {
  const url = new URL(redirectUri);
  if (fields.code) url.searchParams.set("code", fields.code);
  if (fields.error) url.searchParams.set("error", fields.error);
  if (fields.description) url.searchParams.set("error_description", fields.description);
  if (fields.state) url.searchParams.set("state", fields.state);
  url.searchParams.set("iss", issuer);
  return url.toString();
}
