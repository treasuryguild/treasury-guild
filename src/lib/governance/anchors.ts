// Which of a proposal's anchor steps are on-chain, pending, submitted or due,
// and what each step's record entry says (docs/onchain-anchoring-estimate.md,
// phase 3). The one home for the rules; pure and client-safe. The server's
// loadDueAnchors feeds it for the builds, the proposal page for its card.
//
// A step is anchored when a transaction carrying it is confirmed, pending
// while one waits for signatures, submitted once broadcast, and due again
// once every such transaction is rejected or deleted. Only `anchored`
// proposals ever have a due step: those already final when anchoring shipped
// are left alone.
import { AnchorStep, ANCHOR_STEPS, TxState } from "@/lib/constants";
import type { AnchorEntry, AnchorTallyCounts } from "@/lib/cardano/anchorMetadata";
import type { AnchorTransaction, ProposalAnchorWithTx, ProposalRow } from "@/lib/db/types";
import type { DocumentStoreName } from "@/lib/db/types";
import { isFinalProposal } from "./lifecycle";

/** Once a frozen document waits this long for its outside copy, the closed anchor goes without one. */
export const CLOSED_ANCHOR_COPY_GRACE_MS = 24 * 60 * 60 * 1000;

export type AnchorStepStatus = "anchored" | "pending" | "submitted" | "due" | "none";

export interface AnchorStepState {
  status: AnchorStepStatus;
  /** The confirmed transaction (anchored) or the live one (pending / submitted). */
  txId: string | null;
  txHash: string | null;
  /** When the confirmed transaction landed on-chain, if the poller recorded it. */
  blockTime: string | null;
}

export type AnchorStatus = Record<AnchorStep, AnchorStepState>;

/** What the due rules read of a proposal. */
export type AnchorProposal = Pick<
  ProposalRow, "id" | "number" | "state" | "content_hash" | "rules_hash" | "electorate_hash" | "voting_opened_at" | "anchored" | "tally"
>;

/** A frozen tally document and its outside copies, as the closed step reads them. */
export interface AnchorDocument {
  hash: string;
  frozenAt: string;
  copies: { store: DocumentStoreName; locator: string }[];
}

/** The community's publication setting, as the closed step reads it. */
export interface AnchorPublication {
  documentStore: DocumentStoreName | null;
  documentStoreSince: string | null;
}

function txOf(row: ProposalAnchorWithTx): AnchorTransaction | null {
  const tx = row.transactions;
  return Array.isArray(tx) ? (tx[0] ?? null) : tx;
}

const NONE: AnchorStepState = { status: "none", txId: null, txHash: null, blockTime: null };

/** Each step's state from the proposal's anchor rows (a rejected or missing transaction counts for nothing). */
export function anchorStatus(rows: readonly ProposalAnchorWithTx[]): AnchorStatus {
  const status = Object.fromEntries(ANCHOR_STEPS.map((step) => [step, NONE])) as AnchorStatus;
  for (const step of ANCHOR_STEPS) {
    const live = rows.filter((r) => r.step === step).map(txOf).filter((tx): tx is AnchorTransaction => tx !== null);
    const confirmed = live.filter((tx) => tx.state === TxState.Confirmed)
      .sort((a, b) => (a.block_time ?? "").localeCompare(b.block_time ?? ""));
    // Prefer confirmed; else a live pending or submitted row (submitted first so a
    // re-build's pending sibling does not hide a submitted one still settling).
    const submitted = live.find((tx) => tx.state === TxState.Submitted);
    const pending = live.find((tx) => tx.state === TxState.Pending);
    const found = confirmed[0] ?? submitted ?? pending;
    if (!found) continue;
    status[step] = {
      status: confirmed[0] ? "anchored" : found.state === TxState.Submitted ? "submitted" : "pending",
      txId: found.id, txHash: found.tx_hash, blockTime: confirmed[0] ? found.block_time : null,
    };
  }
  return status;
}

/** Closed without a vote: withdrawn, cancelled in discussion, or cancelled for want of voters. */
export function closedWithoutVoting(p: Pick<ProposalRow, "state" | "voting_opened_at">): boolean {
  return isFinalProposal(p.state) && p.voting_opened_at === null;
}

/**
 * The steps due now. The closed step of a proposal that reached voting
 * waits for the frozen document, and then for its copy in the community's
 * chosen store (or a day), so the anchor can carry the locator.
 */
export function dueAnchorSteps(
  proposal: AnchorProposal,
  status: AnchorStatus,
  document: AnchorDocument | null,
  publication: AnchorPublication | null,
  now: number,
): AnchorStep[] {
  if (!proposal.anchored) return [];
  const open = (step: AnchorStep) => status[step].status === "none";
  const exists = (step: AnchorStep) => !open(step);
  const due: AnchorStep[] = [];
  if (closedWithoutVoting(proposal)) {
    // Never anchored: the chain never shows a proposal without an ending, so
    // a closed anchor is due only where a proposed one exists.
    if (exists(AnchorStep.Proposed) && open(AnchorStep.Closed)) due.push(AnchorStep.Closed);
    return due;
  }
  if (open(AnchorStep.Proposed)) due.push(AnchorStep.Proposed);
  if (proposal.voting_opened_at !== null && proposal.electorate_hash && open(AnchorStep.Opened)) due.push(AnchorStep.Opened);
  if (isFinalProposal(proposal.state) && open(AnchorStep.Closed) && document) {
    if (!publicationOn(document, publication) || copyIn(document, publication) || Date.parse(document.frozenAt) + CLOSED_ANCHOR_COPY_GRACE_MS < now) {
      due.push(AnchorStep.Closed);
    }
  }
  return due;
}

/** Whether this document is one the community publishes: a store chosen, and chosen before the freeze. */
function publicationOn(document: AnchorDocument, publication: AnchorPublication | null): boolean {
  return !!publication?.documentStore && !!publication.documentStoreSince &&
    Date.parse(publication.documentStoreSince) <= Date.parse(document.frozenAt);
}

/** The copy in the community's chosen store, if any. */
export function copyIn(document: AnchorDocument, publication: AnchorPublication | null): AnchorDocument["copies"][number] | null {
  if (!publication?.documentStore) return null;
  return document.copies.find((c) => c.store === publication.documentStore) ?? null;
}

/** The record entry of one step; null when the proposal has nothing to say for it yet. */
export function anchorEntryFor(
  step: AnchorStep,
  proposal: AnchorProposal,
  document: AnchorDocument | null,
  publication: AnchorPublication | null,
): AnchorEntry | null {
  switch (step) {
    case AnchorStep.Proposed:
      return [proposal.number, step, proposal.content_hash, proposal.rules_hash];
    case AnchorStep.Opened:
      return proposal.electorate_hash ? [proposal.number, step, proposal.electorate_hash] : null;
    case AnchorStep.Closed: {
      if (!isFinalProposal(proposal.state)) return null;
      if (closedWithoutVoting(proposal)) return [proposal.number, step, proposal.state];
      if (!document) return null;
      const tally = proposal.tally;
      const counts: AnchorTallyCounts = [
        tally?.electorate ?? 0,
        tally?.ballots ?? 0,
        Object.entries(tally?.counts ?? {}).filter((c): c is [string, number] => typeof c[1] === "number")
          .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)),
      ];
      const copy = copyIn(document, publication);
      return copy
        ? [proposal.number, step, proposal.state, document.hash, counts, [copy.store, copy.locator]]
        : [proposal.number, step, proposal.state, document.hash, counts];
    }
  }
}

/** Whether an anchored step's transaction landed after voting opened (a late proposed or opened anchor). */
export function anchoredLate(state: AnchorStepState, votingOpenedAt: string | null): boolean {
  return state.status === "anchored" && !!state.blockTime && !!votingOpenedAt && Date.parse(state.blockTime) > Date.parse(votingOpenedAt);
}
