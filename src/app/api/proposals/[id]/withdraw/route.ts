// The proposer withdraws a proposal before voting opens (end_proposal checks both).
import { sessionRoute } from "@/lib/api/route";
import type { ProposalStateResponse } from "@/lib/api/types";
import { requireMember } from "@/lib/authz";
import { endProposal, loadProposal } from "@/lib/db/governance";

export const POST = sessionRoute<{ id: string }>(async (_req, { params, session }) => {
  const proposal = await loadProposal(params.id);
  await requireMember(proposal.community_id, session.wallet);
  const state = await endProposal(proposal.id, session.wallet, "withdrawn", null);
  return { state, executionState: "not_applicable" } satisfies ProposalStateResponse;
});
