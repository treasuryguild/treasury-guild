// Withdrawing the caller's own proposal through the agent API: the preview
// checks it can be withdrawn and says what that does; draft_confirm ends it
// (end_proposal, which re-checks the proposer and the state under a row lock).
import "server-only";

import { z } from "zod";
import type { ApiCaller } from "@/lib/api/caller";
import type { V1DraftPreview, V1ProposalWithdrawResponse } from "@/lib/api/types";
import { sha256Hex } from "@/lib/auth/crypto";
import { ProposalState } from "@/lib/constants";
import { endProposal, loadProposal, loadProposalByNumber } from "@/lib/db/governance";
import { BadRequestError, ConflictError } from "@/lib/errors";
import { canWithdraw } from "@/lib/governance/lifecycle";
import { mintDraftToken, type VerifiedDraft } from "@/lib/mcp/draftToken";
import type { ProposalRow } from "@/lib/db/types";
import { routes } from "@/lib/routes";
import { defineEndpoint } from "./endpoint";
import { appLink, communityInput, memberCommunity } from "./shared";
import { CONFIRM_NEXT } from "./shape";

function withdrawFingerprint(p: Pick<ProposalRow, "id" | "state" | "content_hash">): string {
  return sha256Hex(`${p.id}\n${p.state}\n${p.content_hash}`);
}

/** Why the caller cannot withdraw this proposal, or null when they can. */
function withdrawRefusal(p: ProposalRow, wallet: string): string | null {
  if (p.proposer !== wallet) return "Only the member who made a proposal can withdraw it";
  if (p.state !== ProposalState.Discussion) {
    return `Proposal #${p.number} is ${p.state}: a proposal can be withdrawn only while it is in discussion`;
  }
  return null;
}

export const previewProposalWithdraw = defineEndpoint({
  scope: "proposals:write",
  input: z.object({
    community: communityInput,
    proposal: z.coerce.number().int().positive().describe("The proposal's number (#N), as proposal_list shows it"),
  }),
  async run(caller, input): Promise<V1DraftPreview> {
    const { community } = await memberCommunity(caller, input.community);
    const p = await loadProposalByNumber(community.id, input.proposal);
    const refusal = withdrawRefusal(p, caller.wallet);
    if (refusal || !canWithdraw(p, caller.wallet)) throw new BadRequestError(refusal ?? "This proposal cannot be withdrawn");
    const { token, expiresAt } = await mintDraftToken(caller, {
      action: "proposal_withdraw",
      community: community.slug,
      request: { proposalId: p.id },
      fingerprint: withdrawFingerprint(p),
      rulesHash: "",
    });
    return {
      community: { slug: community.slug, name: community.name },
      action: "proposal_withdraw",
      summary: `Withdraw proposal #${p.number}: ${p.title}`,
      details: { number: p.number, title: p.title, kind: p.kind, state: p.state, url: appLink(routes.proposal(community.slug, p.id)) },
      effects: [
        "The proposal ends now and for good: nobody can vote on it and it cannot be reopened.",
        "Members see that it was withdrawn by its proposer.",
        "A budget proposal releases the budgets it held, so they can be changed or proposed again.",
      ],
      next: CONFIRM_NEXT,
      draftToken: token,
      expiresAt,
    };
  },
});

/** The proposal_withdraw action, run by draft_confirm. */
export async function confirmProposalWithdraw(caller: ApiCaller, draft: VerifiedDraft): Promise<V1ProposalWithdrawResponse> {
  const { community } = await memberCommunity(caller, draft.community);
  const proposalId = typeof draft.request.proposalId === "string" ? draft.request.proposalId : "";
  const p = await loadProposal(proposalId);
  if (p.community_id !== community.id) throw new BadRequestError("This draft belongs to another community");
  const answer = (created: boolean, state: string): V1ProposalWithdrawResponse => ({
    community: { slug: community.slug, name: community.name },
    created,
    number: p.number,
    title: p.title,
    state,
    url: appLink(routes.proposal(community.slug, p.id)),
  });
  // Confirmed before: it is withdrawn already, by this member.
  if (p.state === ProposalState.Withdrawn && p.ended_by === caller.wallet) return answer(false, p.state);
  if (withdrawFingerprint(p) !== draft.fingerprint) {
    throw new ConflictError(`Proposal #${p.number} changed since the preview (it is ${p.state} now). Preview again if it still applies.`);
  }
  const refusal = withdrawRefusal(p, caller.wallet);
  if (refusal) throw new ConflictError(refusal);
  return answer(true, await endProposal(p.id, caller.wallet, "withdrawn", null));
}
