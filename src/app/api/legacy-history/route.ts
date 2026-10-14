// The community's previous wallets and their history imports, for admins.
import { parseQuery, sessionRoute } from "@/lib/api/route";
import { legacyOverviewQuerySchema } from "@/lib/api/schemas";
import type { LegacyHistoryOverview } from "@/lib/api/types";
import { requireAdmin } from "@/lib/authz";
import { loadLegacyOverview } from "@/lib/db/legacyHistory";

export const GET = sessionRoute(async (req, { session }) => {
  const { communityId } = parseQuery(req, legacyOverviewQuerySchema);
  await requireAdmin(communityId, session.wallet);
  return (await loadLegacyOverview(communityId)) satisfies LegacyHistoryOverview;
});
