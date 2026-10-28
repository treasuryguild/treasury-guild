// Admin read of community Integrations completeness (Discord, payout
// webhooks, GitHub, call platforms, records). Pure assembly in
// src/lib/integrations/; this route only authorizes.
import { parseQuery, sessionRoute } from "@/lib/api/route";
import { communityIdQuerySchema } from "@/lib/api/schemas";
import type { IntegrationsStatusResponse } from "@/lib/api/types";
import { requireAdmin } from "@/lib/authz";
import { loadIntegrationsStatus } from "@/lib/integrations/loadStatus";

export const GET = sessionRoute(async (req, { session }) => {
  const { communityId } = parseQuery(req, communityIdQuerySchema);
  await requireAdmin(communityId, session.wallet);
  // Spread so the handler's JsonValue constraint accepts the assembled status.
  return { ...(await loadIntegrationsStatus(communityId)) } satisfies IntegrationsStatusResponse;
});
