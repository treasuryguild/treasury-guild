// GET /api/oauth/request: the consent page's view of a signed authorization
// request (who asks, where the browser returns, which permissions).
import { parseQuery, publicRoute } from "@/lib/api/route";
import { oauthRequestQuerySchema } from "@/lib/api/schemas";
import type { OAuthRequestResponse } from "@/lib/api/types";
import { BadRequestError } from "@/lib/errors";
import { API_SCOPE_DESCRIPTIONS } from "@/lib/mcp/scopes";
import { isLoopbackRedirect } from "@/lib/oauthServer/redirects";
import { decodeAuthorizationRequest } from "@/lib/oauthServer/request";

export const GET = publicRoute(async (req) => {
  const { request } = parseQuery(req, oauthRequestQuerySchema);
  const decoded = decodeAuthorizationRequest(request);
  if (!decoded) {
    throw new BadRequestError("This request is invalid or has expired. Start again from your AI assistant.");
  }
  return {
    clientId: decoded.clientId,
    clientName: decoded.clientName,
    verifiedDomain: decoded.verifiedDomain,
    redirectHost: new URL(decoded.redirectUri).host,
    redirectIsLocal: isLoopbackRedirect(decoded.redirectUri),
    scopes: decoded.scopes.map((scope) => ({ scope, description: API_SCOPE_DESCRIPTIONS[scope] })),
  } satisfies OAuthRequestResponse;
});
