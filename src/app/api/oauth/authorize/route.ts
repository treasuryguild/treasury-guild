// GET /api/oauth/authorize: the OAuth 2.1 authorization endpoint. Validates the
// request, signs it into a short-lived handle and sends the browser to the
// consent page; no code is issued before the user approves there.
import { NextResponse } from "next/server";
import { clientIp, errorResponse } from "@/lib/api/route";
import { enforceRateLimit } from "@/lib/db/rateLimit";
import { authorizationResponseUrl, authorizeParams, validateAuthorizeRequest } from "@/lib/oauthServer/authorize";
import { resolveClient } from "@/lib/oauthServer/clients";
import { issuerOrigin, resourceUrl } from "@/lib/oauthServer/config";
import { encodeAuthorizationRequest } from "@/lib/oauthServer/request";
import { routes } from "@/lib/routes";

function redirect(location: string): Response {
  const res = NextResponse.redirect(location, 302);
  res.headers.set("Cache-Control", "no-store");
  return res;
}

export async function GET(req: Request): Promise<Response> {
  try {
    await enforceRateLimit("oauthAuthorize", clientIp(req));
    const params = authorizeParams(new URL(req.url));
    const client = params.clientId ? await resolveClient(params.clientId) : null;
    const outcome = validateAuthorizeRequest(params, client, resourceUrl());
    const origin = issuerOrigin();

    switch (outcome.kind) {
      case "render":
        // Our own page, never the unverified redirect_uri; a code, never text.
        return redirect(`${origin}${routes.oauthConsent({ error: outcome.error })}`);
      case "bounce":
        return redirect(authorizationResponseUrl(outcome.redirectUri, origin, outcome));
      case "ok":
        return redirect(`${origin}${routes.oauthConsent({ request: encodeAuthorizationRequest(outcome.request) })}`);
    }
  } catch (err) {
    return errorResponse(err);
  }
}
