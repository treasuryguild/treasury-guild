// POST /api/oauth/register: RFC 7591 Dynamic Client Registration. Deprecated
// by the 2026-07-28 MCP revision in favour of Client ID Metadata Documents,
// kept for clients that cannot do CIMD. Registration is open, as the spec
// expects, so it is rate limited per IP rather than authenticated.
import { randomUUID } from "node:crypto";
import { NextResponse } from "next/server";
import { clientIp, oauthPreflight, oauthRoute } from "@/lib/api/route";
import { saveOAuthClient } from "@/lib/db/oauth";
import { enforceRateLimit } from "@/lib/db/rateLimit";
import { OAuthProtocolError } from "@/lib/errors";
import { generateOpaqueToken, hashToken } from "@/lib/oauthServer/accessToken";
import { MAX_CLIENT_NAME } from "@/lib/oauthServer/clients";
import { isAcceptableRedirectUri, MAX_REDIRECT_URIS } from "@/lib/oauthServer/redirects";

export const POST = oauthRoute(async (req) => {
  await enforceRateLimit("oauthRegister", clientIp(req));
  const text = await req.text();
  if (text.length > 8 * 1024) throw new OAuthProtocolError(413, "invalid_client_metadata", "Request too large");
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new OAuthProtocolError(400, "invalid_client_metadata", "Body must be JSON");
  }

  const redirectUris = Array.isArray(body.redirect_uris)
    ? body.redirect_uris.filter((u): u is string => typeof u === "string")
    : [];
  if (redirectUris.length === 0 || redirectUris.length > MAX_REDIRECT_URIS) {
    throw new OAuthProtocolError(400, "invalid_redirect_uri", `redirect_uris must hold 1-${MAX_REDIRECT_URIS} entries`);
  }
  const bad = redirectUris.find((uri) => !isAcceptableRedirectUri(uri));
  if (bad) {
    throw new OAuthProtocolError(400, "invalid_redirect_uri", `redirect_uri must be https, or http on a loopback host: ${bad}`);
  }

  const name = typeof body.client_name === "string" ? body.client_name.trim() : "";
  // Public clients are the norm (native apps and CLIs cannot keep a secret).
  const method = body.token_endpoint_auth_method;
  const isPublic = method === undefined || method === "none";
  if (!isPublic && method !== "client_secret_post") {
    throw new OAuthProtocolError(400, "invalid_client_metadata", "token_endpoint_auth_method must be none or client_secret_post");
  }
  const secret = isPublic ? null : generateOpaqueToken();
  const client = await saveOAuthClient({
    client_id: `gv-${randomUUID()}`,
    is_metadata_url: false,
    client_name: (name || "Unnamed AI assistant").slice(0, MAX_CLIENT_NAME),
    client_uri: typeof body.client_uri === "string" ? body.client_uri.slice(0, 500) : null,
    redirect_uris: redirectUris,
    token_endpoint_auth_method: isPublic ? "none" : "client_secret_post",
    secret_hash: secret ? hashToken(secret) : null,
  });

  return NextResponse.json({
    client_id: client.client_id,
    ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
    client_id_issued_at: Math.floor(Date.parse(client.created_at) / 1000),
    client_name: client.client_name,
    redirect_uris: client.redirect_uris,
    token_endpoint_auth_method: client.token_endpoint_auth_method,
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
  }, { status: 201 });
});
export const OPTIONS = oauthPreflight;
