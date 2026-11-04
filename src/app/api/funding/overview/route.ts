// Member-readable funding overview: sources, commitments, schedules, and
// received inflows (chain + previous-wallet receipts).
import { parseQuery, sessionRoute } from "@/lib/api/route";
import { legacyOverviewQuerySchema } from "@/lib/api/schemas";
import type { FundingOverview } from "@/lib/db/funding";
import { requireMember } from "@/lib/authz";
import { rows, serviceClient } from "@/lib/db/client";
import { loadFundingOverview } from "@/lib/db/funding";

export const GET = sessionRoute(async (req, { session }) => {
  const { communityId } = parseQuery(req, legacyOverviewQuerySchema);
  await requireMember(communityId, session.wallet);
  const treasuries = rows<{ id: string }>(
    await serviceClient().from("treasuries").select("id").eq("community_id", communityId),
    "load treasuries for funding overview",
  );
  return (await loadFundingOverview(communityId, treasuries.map((t) => t.id))) satisfies FundingOverview;
});
