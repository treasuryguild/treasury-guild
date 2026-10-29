// POST /api/oauth/decision: the user's answer on the consent page. The signed
// handle says what is approved; the session cookie says who approves (never
// the body: a body-supplied wallet would let anyone grant for someone else).
import { parseJson, sessionRoute } from "@/lib/api/route";
import { oauthDecisionSchema } from "@/lib/api/schemas";
import type { OAuthDecisionResponse } from "@/lib/api/types";
import { findOAuthClient, insertAuthorizationCode, saveOAuthGrant } from "@/lib/db/oauth";
import { BadRequestError } from "@/lib/errors";
import { generateOpaqueToken, hashToken } from "@/lib/oauthServer/accessToken";
import { authorizationResponseUrl } from "@/lib/oauthServer/authorize";
import { AUTHORIZATION_CODE_TTL_SECONDS, issuerOrigin } from "@/lib/oauthServer/config";
import { findMatchingRedirectUri, isAcceptableRedirectUri } from "@/lib/oauthServer/redirects";
import { decodeAuthorizationRequest } from "@/lib/oauthServer/request";

export const POST = sessionRoute(async (req, { session }) => {
  const { request, approved, scopes } = await parseJson(req, oauthDecisionSchema);
  const decoded = decodeAuthorizationRequest(request);
  if (!decoded) {
    throw new BadRequestError("This request is invalid or has expired. Start again from your AI assistant.");
  }
  // The last check before the URL reaches window.location.
  if (!isAcceptableRedirectUri(decoded.redirectUri)) {
    throw new BadRequestError("The assistant's return address is not permitted");
  }
  const client = await findOAuthClient(decoded.clientId);
  if (!client) {
    throw new BadRequestError("This AI assistant is no longer registered. Start again from it.");
  }
  // Re-check against the registered list: the handle alone must not invent a URI.
  if (!findMatchingRedirectUri(client.redirect_uris, decoded.redirectUri)) {
    throw new BadRequestError("The assistant's return address is not registered for this client");
  }
  const issuer = issuerOrigin();
  const state = decoded.state ?? null;

  if (!approved) {
    return {
      redirectTo: authorizationResponseUrl(decoded.redirectUri, issuer, {
        error: "access_denied", description: "The user denied the request", state,
      }),
    } satisfies OAuthDecisionResponse;
  }

  // The handle is the ceiling: ticked boxes only narrow it.
  const granted = scopes ? decoded.scopes.filter((s) => scopes.includes(s)) : decoded.scopes;
  if (granted.length === 0) {
    throw new BadRequestError("Select at least one permission, or deny the request.");
  }

  await saveOAuthGrant(session.wallet, decoded.clientId, granted);
  const code = generateOpaqueToken();
  await insertAuthorizationCode({
    code_hash: hashToken(code),
    client_id: decoded.clientId,
    wallet_address: session.wallet,
    scopes: granted,
    resource: decoded.resource,
    redirect_uri: decoded.redirectUri,
    code_challenge: decoded.codeChallenge,
    expires_at: new Date(Date.now() + AUTHORIZATION_CODE_TTL_SECONDS * 1000).toISOString(),
  });
  return {
    redirectTo: authorizationResponseUrl(decoded.redirectUri, issuer, { code, state }),
  } satisfies OAuthDecisionResponse;
});
