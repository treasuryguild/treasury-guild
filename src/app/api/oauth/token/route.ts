// POST /api/oauth/token: authorization_code (PKCE) and refresh_token
// (rotating) grants, form-encoded per RFC 6749 (JSON accepted as well).
import { clientIp, oauthPreflight, oauthRoute } from "@/lib/api/route";
import { safeEqual } from "@/lib/auth/crypto";
import { enforceRateLimit } from "@/lib/db/rateLimit";
import { OAuthProtocolError } from "@/lib/errors";
import { hashToken } from "@/lib/oauthServer/accessToken";
import { resolveClient } from "@/lib/oauthServer/clients";
import { exchangeAuthorizationCode, exchangeRefreshToken } from "@/lib/oauthServer/tokens";

const MAX_BODY_CHARS = 8 * 1024;

async function readParams(req: Request): Promise<Record<string, string>> {
  const text = await req.text();
  if (text.length > MAX_BODY_CHARS) throw new OAuthProtocolError(413, "invalid_request", "Request too large");
  if ((req.headers.get("content-type") ?? "").includes("application/json")) {
    try {
      const parsed = JSON.parse(text) as Record<string, unknown>;
      return Object.fromEntries(
        Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      );
    } catch {
      throw new OAuthProtocolError(400, "invalid_request", "Malformed JSON body");
    }
  }
  return Object.fromEntries(new URLSearchParams(text));
}

export const POST = oauthRoute(async (req) => {
  await enforceRateLimit("oauthToken", clientIp(req));
  const params = await readParams(req);
  const clientId = params.client_id;
  if (!clientId) throw new OAuthProtocolError(400, "invalid_client", "client_id is required");

  const client = await resolveClient(clientId);
  if (!client) throw new OAuthProtocolError(401, "invalid_client", "Unknown client");
  // Confidential clients authenticate; public ones ("none") rely on PKCE.
  if (client.token_endpoint_auth_method !== "none") {
    const secret = params.client_secret;
    if (!secret || !client.secret_hash || !safeEqual(hashToken(secret), client.secret_hash)) {
      throw new OAuthProtocolError(401, "invalid_client", "Client authentication failed");
    }
  }

  switch (params.grant_type) {
    case "authorization_code": {
      if (!params.code || !params.code_verifier) {
        throw new OAuthProtocolError(400, "invalid_request", "code and code_verifier are required");
      }
      return exchangeAuthorizationCode(client.client_id, {
        code: params.code,
        codeVerifier: params.code_verifier,
        redirectUri: params.redirect_uri ?? null,
      });
    }
    case "refresh_token": {
      if (!params.refresh_token) throw new OAuthProtocolError(400, "invalid_request", "refresh_token is required");
      return exchangeRefreshToken(client.client_id, {
        refreshToken: params.refresh_token,
        scope: params.scope ?? null,
      });
    }
    default:
      throw new OAuthProtocolError(400, "unsupported_grant_type", "Supported: authorization_code, refresh_token");
  }
});
export const OPTIONS = oauthPreflight;
