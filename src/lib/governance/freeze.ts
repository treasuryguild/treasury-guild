// Freezing a proposal's tally document (migration 0059): once a proposal
// that reached voting is final, its document is built once and stored with
// its hash by the write-once freeze_proposal_tally RPC. Called right after
// a close (advance.ts), after a cancel during voting, and by the reconcile
// sweep for anything left over (a crash in between, or the proposals that
// were already closed when this shipped). Best effort everywhere: the
// lifecycle never waits for it.
import "server-only";

import { communitySlug } from "@/lib/db/communities";
import { freezeProposalTally, listProposalsToFreeze, loadProposalBallots } from "@/lib/db/governance";
import type { ProposalRow } from "@/lib/db/types";
import { appUrl } from "@/lib/env.server";
import { isFinalProposal } from "./lifecycle";
import { buildTallyDocument, tallyDocumentText } from "./tallyDocument";

/** Whether the proposal gets a frozen document: final, and voting opened. */
export function freezable(p: Pick<ProposalRow, "state" | "voting_opened_at">): boolean {
  return isFinalProposal(p.state) && p.voting_opened_at !== null;
}

/** Build and store the document; true when this call stored it, false when nothing was to do. */
export async function freezeTallyDocument(proposal: ProposalRow): Promise<boolean> {
  if (!freezable(proposal)) return false;
  const community = await communitySlug(proposal.community_id);
  const doc = buildTallyDocument({
    app: new URL(appUrl()).host,
    community,
    proposal,
    ...(await loadProposalBallots(proposal.id)),
  });
  return freezeProposalTally(proposal.id, tallyDocumentText(doc), doc.hash);
}

/** Freeze without letting a failure reach the caller (logged). */
export async function tryFreezeTallyDocument(proposal: ProposalRow): Promise<void> {
  try {
    await freezeTallyDocument(proposal);
  } catch (err) {
    console.error(`freeze tally document of proposal ${proposal.id} failed`, err);
  }
}

export interface FreezeSweepResult {
  frozen: number;
  failed: number;
}

/** The sweep's pass: every final proposal that reached voting and has no document yet. */
export async function freezeMissingTallyDocuments(): Promise<FreezeSweepResult> {
  const result: FreezeSweepResult = { frozen: 0, failed: 0 };
  for (const proposal of await listProposalsToFreeze()) {
    try {
      if (await freezeTallyDocument(proposal)) result.frozen += 1;
    } catch (err) {
      console.error(`freeze tally document of proposal ${proposal.id} failed`, err);
      result.failed += 1;
    }
  }
  return result;
}
