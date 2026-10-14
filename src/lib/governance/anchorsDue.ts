// The community's anchors due now, with the record entry each would put
// on-chain: what a payout or payment build attaches, what the dedicated
// anchor route carries, and what the Proposals and Treasury pages list. One
// home for the loading; the rules themselves are pure (anchors.ts).
import "server-only";

import type { AnchorEntry } from "@/lib/cardano/anchorMetadata";
import { compareAnchorEntries } from "@/lib/cardano/anchorMetadata";
import type { AnchorStep } from "@/lib/constants";
import { loadAnchorCandidates, loadFrozenDocuments } from "@/lib/db/anchors";
import { loadGovernanceCommunitySettings } from "@/lib/db/governance";
import { anchorEntryFor, anchorStatus, dueAnchorSteps, type AnchorDocument } from "./anchors";

/** One due step of one proposal, with what its anchor says. */
export interface DueAnchor {
  proposalId: string;
  number: number;
  step: AnchorStep;
  entry: AnchorEntry;
}

/** Every step due in the community, proposals in number order and steps in lifecycle order. */
export async function loadDueAnchors(communityId: string, now: number = Date.now()): Promise<DueAnchor[]> {
  const candidates = await loadAnchorCandidates(communityId);
  if (candidates.length === 0) return [];
  const [documents, settings] = await Promise.all([
    loadFrozenDocuments(candidates.map((p) => p.id)),
    loadGovernanceCommunitySettings(communityId),
  ]);
  const publication = { documentStore: settings.documentStore, documentStoreSince: settings.documentStoreSince };
  const due: DueAnchor[] = [];
  for (const proposal of candidates) {
    const frozen = documents.get(proposal.id);
    const document: AnchorDocument | null = frozen
      ? { hash: frozen.hash, frozenAt: frozen.frozen_at, copies: frozen.proposal_document_copies }
      : null;
    const status = anchorStatus(proposal.proposal_anchors);
    for (const step of dueAnchorSteps(proposal, status, document, publication, now)) {
      const entry = anchorEntryFor(step, proposal, document, publication);
      if (entry) due.push({ proposalId: proposal.id, number: proposal.number, step, entry });
    }
  }
  return due.sort((a, b) => compareAnchorEntries(a.entry, b.entry));
}

/**
 * For the payout and payment builds: the due anchors, or none when loading
 * them fails (logged). A governance bug never blocks a payout; the anchors
 * stay due for the next build or a dedicated transaction.
 */
export async function loadDueAnchorsBestEffort(communityId: string): Promise<DueAnchor[]> {
  try {
    return await loadDueAnchors(communityId);
  } catch (err) {
    console.error(`load due anchors of community ${communityId} failed`, err);
    return [];
  }
}
