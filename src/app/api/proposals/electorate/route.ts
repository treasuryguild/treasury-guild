// How many members would vote on a proposal of this kind made now, for the
// forms that make one and the Governance settings page.
import { parseQuery, sessionRoute } from "@/lib/api/route";
import { electorateQuerySchema } from "@/lib/api/schemas";
import type { ElectoratePreviewResponse } from "@/lib/api/types";
import { requireMember } from "@/lib/authz";
import { countElectorate, loadGovernanceSettings } from "@/lib/db/governance";
import { rulesFor } from "@/lib/governance/rules";

export const GET = sessionRoute(async (req, { session }) => {
  const { communityId, kind, workgroupIds } = parseQuery(req, electorateQuerySchema);
  await requireMember(communityId, session.wallet);
  const rules = rulesFor(await loadGovernanceSettings(communityId, kind));
  return { count: await countElectorate(communityId, rules, workgroupIds) } satisfies ElectoratePreviewResponse;
});
