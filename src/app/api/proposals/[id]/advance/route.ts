// A member's page saw a deadline pass: take the proposal's due step now
// rather than at the next sweep. Every step re-checks the clock in SQL.
import { sessionRoute } from "@/lib/api/route";
import type { ProposalStateResponse } from "@/lib/api/types";
import { requireMember } from "@/lib/authz";
import { loadProposal } from "@/lib/db/governance";
import { advanceProposal } from "@/lib/governance/advance";

export const POST = sessionRoute<{ id: string }>(async (_req, { params, session }) => {
  await requireMember((await loadProposal(params.id)).community_id, session.wallet);
  const proposal = await advanceProposal(params.id);
  return { state: proposal.state, executionState: proposal.execution_state } satisfies ProposalStateResponse;
});
