// An admin cancels an open proposal, with a reason every member sees.
import { parseJson, sessionRoute } from "@/lib/api/route";
import { endProposalSchema } from "@/lib/api/schemas";
import type { ProposalStateResponse } from "@/lib/api/types";
import { requireAdmin } from "@/lib/authz";
import { endProposal, loadProposal } from "@/lib/db/governance";
import { tryFreezeTallyDocument } from "@/lib/governance/freeze";

export const POST = sessionRoute<{ id: string }>(async (req, { params, session }) => {
  const { reason } = await parseJson(req, endProposalSchema);
  const proposal = await loadProposal(params.id);
  await requireAdmin(proposal.community_id, session.wallet);
  const state = await endProposal(proposal.id, session.wallet, "cancelled", reason ?? null);
  // Cancelled during voting: the ballots cast so far are its final record.
  if (proposal.voting_opened_at) await tryFreezeTallyDocument(await loadProposal(proposal.id));
  return { state, executionState: "not_applicable" } satisfies ProposalStateResponse;
});
