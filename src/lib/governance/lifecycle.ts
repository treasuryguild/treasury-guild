// How a proposal moves: discussion → voting → passed | rejected | expired,
// withdrawn or cancelled on the way, and a passed one carried out. The SQL
// functions enforce every transition; this decides which one is due, for the
// sweep and for the page that nudges a proposal whose deadline passed.
// Client-safe.
import { ExecutionState, ProposalState } from "@/lib/constants";
import type { ProposalRow } from "@/lib/db/types";

export type DueAction = "open" | "close" | "execute";

type Timing = Pick<ProposalRow, "state" | "voting_starts_at" | "closes_at" | "execution_state">;

export function dueAction(p: Timing, now: number): DueAction | null {
  if (p.state === ProposalState.Discussion && Date.parse(p.voting_starts_at) <= now) return "open";
  if (p.state === ProposalState.Voting && p.closes_at && Date.parse(p.closes_at) <= now) return "close";
  if (p.state === ProposalState.Passed && p.execution_state === ExecutionState.Pending) return "execute";
  return null;
}

/** Still being discussed or voted on. */
export function isOpenProposal(state: string): boolean {
  return state === ProposalState.Discussion || state === ProposalState.Voting;
}

/** Passed, rejected, expired, withdrawn or cancelled: nothing about the vote changes any more. */
export function isFinalProposal(state: string): boolean {
  return !isOpenProposal(state);
}

/** Ballots are accepted: voting opened and its deadline is ahead. */
export function isVotingOpen(p: Pick<ProposalRow, "state" | "closes_at">, now: number): boolean {
  return p.state === ProposalState.Voting && !!p.closes_at && Date.parse(p.closes_at) > now;
}

export function canWithdraw(p: Pick<ProposalRow, "state" | "proposer">, wallet: string | null): boolean {
  return p.state === ProposalState.Discussion && !!wallet && p.proposer === wallet;
}

export function canCancel(p: Pick<ProposalRow, "state">, isAdmin: boolean): boolean {
  return isAdmin && isOpenProposal(p.state);
}

/** Every ballot is visible: voting closed, or the rules show results live. */
export function ballotsVisible(p: Pick<ProposalRow, "state" | "rules">): boolean {
  return !isOpenProposal(p.state) || !p.rules.hideResults;
}
