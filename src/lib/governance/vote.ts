// Voting: the server issues the ballot text for a choice, the voter's wallet
// signs it (CIP-30 signData), and the signed ballot is accepted only if the
// server, building the same text again from its own data, finds the
// signature valid for it and made by the session wallet's payment key.
import "server-only";

import type { BallotTextResponse, CastVoteResponse } from "@/lib/api/types";
import { verifyWalletSignature } from "@/lib/auth/walletSignature";
import { requireMember } from "@/lib/authz";
import { MAX_VOTE_REASON, METHOD_CHOICES, REASONED_CHOICES, type VoteChoice } from "@/lib/constants";
import { communitySlug } from "@/lib/db/communities";
import { castProposalVote, loadProposal, loadVoter } from "@/lib/db/governance";
import type { ProposalRow } from "@/lib/db/types";
import { appUrl } from "@/lib/env.server";
import { BadRequestError, ConflictError, ForbiddenError, UnauthorizedError } from "@/lib/errors";
import { ballotText, isFreshBallot, normalizeReason } from "./ballot";
import { isVotingOpen } from "./lifecycle";

interface Ballot {
  choice: VoteChoice;
  reason?: string;
}

/** Everything but the signature is checked before the wallet is asked to sign. */
async function checkedBallot(proposalId: string, voter: string, ballot: Ballot) {
  const proposal = await loadProposal(proposalId);
  await requireMember(proposal.community_id, voter);
  if (!isVotingOpen(proposal, Date.now())) throw new ConflictError("Voting is not open on this proposal");
  if (!METHOD_CHOICES[proposal.rules.method].includes(ballot.choice)) {
    throw new BadRequestError("That choice does not exist for this proposal");
  }
  const reason = normalizeReason(ballot.reason);
  if (reason && reason.length > MAX_VOTE_REASON) throw new BadRequestError(`Keep the reason under ${MAX_VOTE_REASON} characters`);
  if (!reason && REASONED_CHOICES.includes(ballot.choice)) throw new BadRequestError("Give a reason for your objection");
  const seat = await loadVoter(proposalId, voter);
  if (!seat) throw new ForbiddenError("You are not in this proposal's electorate");
  if (seat.recused) throw new ForbiddenError("You are recused from this proposal because it benefits you");
  return { proposal, reason };
}

async function textFor(proposal: ProposalRow, voter: string, choice: VoteChoice, reason: string | null, signedAt: string) {
  return ballotText({
    host: new URL(appUrl()).host,
    community: await communitySlug(proposal.community_id),
    proposalNumber: proposal.number,
    proposalId: proposal.id,
    contentHash: proposal.content_hash,
    rulesHash: proposal.rules_hash,
    electorateHash: proposal.electorate_hash,
    choice,
    reason,
    voter,
    signedAt,
  });
}

export async function issueBallot(proposalId: string, voter: string, ballot: Ballot): Promise<BallotTextResponse> {
  const { proposal, reason } = await checkedBallot(proposalId, voter, ballot);
  const signedAt = new Date().toISOString();
  return { text: await textFor(proposal, voter, ballot.choice, reason, signedAt), signedAt };
}

export async function castBallot(
  proposalId: string,
  voter: string,
  signed: Ballot & { signedAt: string; key: string; signature: string },
): Promise<CastVoteResponse> {
  const { proposal, reason } = await checkedBallot(proposalId, voter, signed);
  if (!isFreshBallot(signed.signedAt, Date.now())) throw new BadRequestError("This ballot expired before it was signed. Vote again.");
  const signedAt = new Date(signed.signedAt).toISOString();
  const text = await textFor(proposal, voter, signed.choice, reason, signedAt);
  if (!(await verifyWalletSignature(text, signed, voter))) {
    throw new UnauthorizedError("The signature does not match this ballot. Sign with the wallet you signed in with.");
  }
  const ballotsCast = await castProposalVote({
    proposalId, voter, choice: signed.choice, reason, signedAt, signedText: text, key: signed.key, signature: signed.signature,
  });
  return { ballotsCast };
}
