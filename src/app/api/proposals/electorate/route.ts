// How many members would vote on a proposal of this kind made now, for the
// forms that make one. `eligible` is that count after recusal.
import { parseQuery, sessionRoute } from "@/lib/api/route";
import { electorateQuerySchema } from "@/lib/api/schemas";
import type { ElectoratePreviewResponse } from "@/lib/api/types";
import { requireMember } from "@/lib/authz";
import { ProposalKind } from "@/lib/constants";
import { electorateWallets, loadGovernanceSettings, workgroupLeadWallets } from "@/lib/db/governance";
import { eligibleVoterCount } from "@/lib/governance/electorate";
import { rulesFor } from "@/lib/governance/rules";

export const GET = sessionRoute(async (req, { session }) => {
  const {
    communityId, kind, workgroupIds, electorate, activityMonths, minMemberDays, recuseBeneficiaries, beneficiaries,
  } = parseQuery(req, electorateQuerySchema);
  await requireMember(communityId, session.wallet);
  const saved = rulesFor(await loadGovernanceSettings(communityId, kind));
  const rules = {
    ...saved,
    ...(electorate !== undefined ? { electorate } : {}),
    ...(activityMonths !== undefined ? { activityMonths } : {}),
    ...(minMemberDays !== undefined ? { minMemberDays } : {}),
    ...(recuseBeneficiaries !== undefined ? { recuseBeneficiaries } : {}),
  };
  const wallets = await electorateWallets(communityId, rules, workgroupIds);
  // A budget's beneficiaries are the leads of the workgroups it changes, as create does.
  const recused = kind === ProposalKind.Budget && rules.recuseBeneficiaries
    ? await workgroupLeadWallets(workgroupIds)
    : beneficiaries;
  return {
    count: wallets.length,
    eligible: eligibleVoterCount(wallets, recused, rules.recuseBeneficiaries),
  } satisfies ElectoratePreviewResponse;
});
