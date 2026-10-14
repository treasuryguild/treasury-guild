// OAuth 2.1 authorization server for the agent API (/api/mcp, /api/v1):
// identities, lifetimes and the RFC 8414 / RFC 9728 metadata documents.
//
// The issuer comes from APP_URL, never from the request Host header: a
// header-derived issuer would let whoever controls DNS publish metadata that
// points clients at their own authorization server.
import "server-only";

import { appUrl } from "@/lib/env.server";
import { API_SCOPES } from "@/lib/mcp/scopes";

/** The MCP endpoint this server protects; also the token audience. */
export const MCP_RESOURCE_PATH = "/api/mcp";

export const ACCESS_TOKEN_TTL_SECONDS = 60 * 60;
export const REFRESH_TOKEN_TTL_SECONDS = 30 * 24 * 60 * 60;
/** OAuth 2.1: SHOULD be at most ten minutes; clients redeem at once. */
export const AUTHORIZATION_CODE_TTL_SECONDS = 60;
/** How long the consent page may take between /authorize and the decision. */
export const AUTHORIZE_REQUEST_TTL_MS = 10 * 60 * 1000;

export function issuerOrigin(): string {
  return appUrl().replace(/\/+$/, "");
}

/**
 * The RFC 8707 resource every access token is bound to. /api/v1 accepts the
 * same audience: the MCP tools and the REST routes are one resource server.
 */
export function resourceUrl(): string {
  return `${issuerOrigin()}${MCP_RESOURCE_PATH}`;
}

export function protectedResourceMetadataUrl(): string {
  return `${issuerOrigin()}/.well-known/oauth-protected-resource${MCP_RESOURCE_PATH}`;
}

/** RFC 8414 Authorization Server Metadata. */
export function authorizationServerMetadata() {
  const origin = issuerOrigin();
  return {
    issuer: origin,
    authorization_endpoint: `${origin}/api/oauth/authorize`,
    token_endpoint: `${origin}/api/oauth/token`,
    registration_endpoint: `${origin}/api/oauth/register`,
    scopes_supported: [...API_SCOPES],
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    // S256 only: OAuth 2.1 removes `plain`.
    code_challenge_methods_supported: ["S256"],
    // Claude Code picks Client ID Metadata Documents only when BOTH "none"
    // and client_id_metadata_document_supported are advertised; otherwise it
    // falls back to Dynamic Client Registration.
    token_endpoint_auth_methods_supported: ["none", "client_secret_post"],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${origin}/docs/ai-assistants`,
  };
}

/** RFC 9728 Protected Resource Metadata. */
export function protectedResourceMetadata() {
  const origin = issuerOrigin();
  return {
    resource: resourceUrl(),
    authorization_servers: [origin],
    scopes_supported: [...API_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Treasury Guild",
    resource_documentation: `${origin}/docs/ai-assistants`,
  };
}
