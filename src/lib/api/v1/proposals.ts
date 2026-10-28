// A community's proposals: what each would change, how it is decided, where
// it stands, the result once voting closed, and the caller's own vote.
// Read-only: voting needs a wallet signature, which only the app asks for.
import "server-only";

import { z } from "zod";
import type { V1Proposal, V1ProposalDetailResponse, V1ProposalsResponse } from "@/lib/api/types";
import {
  loadDocumentCopies, loadProposalBallots, loadProposalEvents, loadProposalListing, loadTallyDocument, type ProposalListing,
} from "@/lib/db/governance";
import { loadMemberLabels } from "@/lib/db/payments";
import { loadEditableTask } from "@/lib/db/tasks";
import { NotFoundError } from "@/lib/errors";
import type { ProposalRow } from "@/lib/db/types";
import { truncate } from "@/lib/format";
import { proposalChangeLines } from "@/lib/governance/describe";
import { describeElectorate, describeMethod, voterName } from "@/lib/governance/labels";
import { ballotsVisible, isVotingOpen } from "@/lib/governance/lifecycle";
import { OUTCOME_TEXT, type OutcomeReason } from "@/lib/governance/tally";
import { routes } from "@/lib/routes";
import { defineEndpoint } from "./endpoint";
import { appLink, communityInput, memberCommunity } from "./shared";

export const PROPOSAL_LIST_MAX = 100;
const TEXT_MAX = 2000;

export function describeProposal(slug: string, p: ProposalRow, listing: ProposalListing, now: number): V1Proposal {
  const member = (wallet: string) => voterName(wallet, listing.handles.get(wallet));
  const vote = listing.myVotes.get(p.id);
  const seat = listing.mySeats.get(p.id);
  return {
    number: p.number,
    kind: p.kind,
    state: p.state,
    title: p.title,
    text: truncate(p.body, TEXT_MAX),
    discussionUrl: p.discussion_url,
    discordDiscussionUrl: p.discord_discussion_url,
    proposer: member(p.proposer),
    changes: proposalChangeLines(p, { owner: (id) => listing.ownerNames.get(id), member }),
    decidedBy: describeMethod(p.rules),
    electorate: describeElectorate(p.rules),
    voters: p.electorate_size,
    ballotsCast: p.ballots_cast,
    createdAt: p.created_at,
    votingOpensAt: p.voting_starts_at,
    votingClosesAt: p.closes_at,
    closedAt: p.closed_at,
    // The tally is recorded at the close only: nothing about hidden ballots leaks.
    result: p.tally
      ? { outcome: OUTCOME_TEXT[p.tally.reason as OutcomeReason] ?? p.tally.reason, counts: p.tally.counts as Record<string, number> }
      : null,
    carriedOut: p.execution_state && p.execution_state !== "not_applicable"
      ? { state: p.execution_state, error: p.execution_error }
      : null,
    endReason: p.end_reason,
    myVote: vote ? { choice: vote.choice, reason: vote.reason, signedAt: vote.signed_at } : null,
    canVote: seat === false && isVotingOpen(p, now),
    contentHash: p.content_hash,
    rulesHash: p.rules_hash,
    electorateHash: p.electorate_hash,
    tallyHash: listing.tallyHashes.get(p.id) ?? null,
    anchors: {
      proposed: listing.anchors.get(p.id)?.proposed ?? null,
      opened: listing.anchors.get(p.id)?.opened ?? null,
      closed: listing.anchors.get(p.id)?.closed ?? null,
    },
    url: appLink(routes.proposal(slug, p.id)),
  };
}

export const listProposals = defineEndpoint({
  scope: "communities:read",
  input: z.object({
    community: communityInput,
    state: z.enum(["open", "closed", "all"]).default("all")
      .describe("open: in discussion or voting; closed: decided, withdrawn or cancelled"),
    limit: z.coerce.number().int().min(1).max(PROPOSAL_LIST_MAX).default(20)
      .describe("Newest proposals first, at most this many"),
  }),
  async run(caller, input): Promise<V1ProposalsResponse> {
    const { community } = await memberCommunity(caller, input.community);
    const listing = await loadProposalListing(community.id, caller.wallet, {
      open: input.state === "all" ? null : input.state === "open",
      limit: input.limit,
    });
    const now = Date.now();
    return {
      community: { slug: community.slug, name: community.name },
      proposals: listing.proposals.map((p) => describeProposal(community.slug, p, listing, now)),
      total: listing.total,
    };
  },
});

export const proposalDetail = defineEndpoint({
  scope: "communities:read",
  input: z.object({
    community: communityInput,
    proposal: z.coerce.number().int().positive().describe("The proposal's number (#N), as proposal_list shows it"),
  }),
  async run(caller, input): Promise<V1ProposalDetailResponse> {
    const { community } = await memberCommunity(caller, input.community);
    const listing = await loadProposalListing(community.id, caller.wallet, { open: null, limit: 1, number: input.proposal });
    const p = listing.proposals[0];
    if (!p) throw new NotFoundError(`No proposal #${input.proposal} in this community`);

    const visible = ballotsVisible(p);
    const [events, ballots, tally, copies] = await Promise.all([
      loadProposalEvents(p.id),
      loadProposalBallots(p.id),
      loadTallyDocument(p.id),
      loadDocumentCopies(p.id),
    ]);
    const labels = await loadMemberLabels(community.id, [
      ...events.flatMap((e) => (e.actor ? [e.actor] : [])),
      ...ballots.votes.map((v) => v.voter),
    ]);
    const name = (wallet: string) => voterName(wallet, labels.get(wallet) ?? listing.handles.get(wallet));
    const result = (p.execution_result ?? {}) as { workgroupId?: string; taskId?: string };

    return {
      community: { slug: community.slug, name: community.name },
      proposal: { ...describeProposal(community.slug, p, listing, Date.now()), text: p.body },
      events: events.map((e) => ({ action: e.action, by: e.actor ? name(e.actor) : null, detail: e.detail, at: e.occurred_at })),
      voters: ballots.voters.length,
      recused: ballots.voters.filter((v) => v.recused).length,
      // Others' ballots only once the community may see them, as RLS shows them in the app.
      ballots: visible
        ? ballots.votes
          .map((v) => ({ voter: name(v.voter), choice: v.choice, reason: v.reason, signedAt: v.signed_at }))
          .sort((a, b) => a.signedAt.localeCompare(b.signedAt))
        : null,
      ballotsHidden: visible ? null : "The ballots stay hidden until voting closes (this community shows only turnout while voting runs). After the close, members see every ballot.",
      tally: tally
        ? { hash: tally.hash, frozenAt: tally.frozen_at, copies: copies.map((c) => ({ store: c.store, locator: c.locator })) }
        : null,
      created: await createdBy(community.slug, result),
    };
  },
});

/** What a carried-out proposal made: the new workgroup's board, or the task with its number. */
async function createdBy(
  slug: string,
  result: { workgroupId?: string; taskId?: string },
): Promise<V1ProposalDetailResponse["created"]> {
  if (result.workgroupId) return { workgroupBoard: appLink(routes.board(slug, result.workgroupId)) };
  if (result.taskId) {
    const task = await loadEditableTask(result.taskId);
    if (task) return { taskNumber: task.number, taskBoard: appLink(routes.board(slug, task.workgroup_id)) };
  }
  return null;
}
