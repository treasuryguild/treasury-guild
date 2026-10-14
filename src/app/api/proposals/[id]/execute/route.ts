// An admin retries carrying out a passed proposal whose application failed
// (the sweep never retries a failure on its own).
import { sessionRoute } from "@/lib/api/route";
import type { ProposalStateResponse } from "@/lib/api/types";
import { requireAdmin } from "@/lib/authz";
import { executeProposal, loadProposal } from "@/lib/db/governance";

export const POST = sessionRoute<{ id: string }>(async (_req, { params, session }) => {
  const proposal = await loadProposal(params.id);
  await requireAdmin(proposal.community_id, session.wallet);
  const executionState = await executeProposal(proposal.id, session.wallet);
  return { state: proposal.state, executionState } satisfies ProposalStateResponse;
});
