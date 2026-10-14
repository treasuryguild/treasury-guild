// The AI assistants the session wallet approved (Settings), and revoking one:
// the grant goes and its refresh tokens stop working at once; access tokens
// already issued fail on their next request, because every agent API request
// re-reads the grant.
import { parseQuery, sessionRoute } from "@/lib/api/route";
import { oauthConnectionQuerySchema } from "@/lib/api/schemas";
import type { OAuthConnectionsResponse } from "@/lib/api/types";
import { deleteOAuthGrant, listOAuthGrants } from "@/lib/db/oauth";
import { NotFoundError } from "@/lib/errors";
import { knownScopes } from "@/lib/mcp/scopes";

export const GET = sessionRoute(async (_req, { session }) => {
  const grants = await listOAuthGrants(session.wallet);
  return {
    connections: grants.map((g) => ({
      clientId: g.client_id,
      clientName: g.oauth_clients?.client_name ?? g.client_id,
      scopes: knownScopes(g.scopes),
      connectedAt: g.updated_at,
      lastUsedAt: g.last_used_at,
    })),
  } satisfies OAuthConnectionsResponse;
});

export const DELETE = sessionRoute(async (req, { session }) => {
  const { clientId } = parseQuery(req, oauthConnectionQuerySchema);
  if (!(await deleteOAuthGrant(session.wallet, clientId))) throw new NotFoundError("Connection not found");
  return { ok: true };
});
