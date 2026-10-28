// The community's anchors due now, with the record entry each would put
// on-chain: what a payout or payment build attaches, what the dedicated
// anchor route carries, and what the Proposals and Treasury pages list. One
// home for the loading; the rules themselves are pure (anchors.ts). Also
// the Discord alert candidates (stale due steps and copy-grace reminders).
import "server-only";

import type { AnchorEntry } from "@/lib/cardano/anchorMetadata";
import { compareAnchorEntries } from "@/lib/cardano/anchorMetadata";
import { AnchorStep } from "@/lib/constants";
import { loadAnchorCandidates, loadFrozenDocuments } from "@/lib/db/anchors";
import { loadGovernanceCommunitySettings } from "@/lib/db/governance";
import {
  anchorEntryFor, anchorStatus, copyGraceReminderDue, dueAnchorSteps, dueSince, isStaleDue,
  type AnchorDocument, type AnchorPublication,
} from "./anchors";

/** One due step of one proposal, with what its anchor says. */
export interface DueAnchor {
  proposalId: string;
  number: number;
  step: AnchorStep;
  entry: AnchorEntry;
}

export type AnchorAlertKind = "stale" | "copy_grace";

/** A Discord reminder for one (proposal, step, kind), keyed by dueSince for stamps. */
export interface AnchorAlertCandidate {
  proposalId: string;
  number: number;
  title: string;
  step: AnchorStep;
  kind: AnchorAlertKind;
  /** ISO timestamp of when this due/grace episode started. */
  dueSince: string;
}

/** Every step due in the community, proposals in number order and steps in lifecycle order. */
export async function loadDueAnchors(communityId: string, now: number = Date.now()): Promise<DueAnchor[]> {
  const { candidates, documents, publication } = await loadCommunityAnchorContext(communityId);
  const due: DueAnchor[] = [];
  for (const proposal of candidates) {
    const document = documentOf(documents, proposal.id);
    const status = anchorStatus(proposal.proposal_anchors);
    for (const step of dueAnchorSteps(proposal, status, document, publication, now)) {
      const entry = anchorEntryFor(step, proposal, document, publication);
      if (entry) due.push({ proposalId: proposal.id, number: proposal.number, step, entry });
    }
  }
  return due.sort((a, b) => compareAnchorEntries(a.entry, b.entry));
}

/**
 * Stale due steps and copy-grace reminders for the community's Discord
 * channel. Empty when nothing is overdue or inside the grace reminder window.
 */
export async function loadAnchorAlertCandidates(
  communityId: string,
  now: number = Date.now(),
): Promise<AnchorAlertCandidate[]> {
  const { candidates, documents, publication } = await loadCommunityAnchorContext(communityId);
  const alerts: AnchorAlertCandidate[] = [];
  for (const proposal of candidates) {
    const document = documentOf(documents, proposal.id);
    const status = anchorStatus(proposal.proposal_anchors);
    for (const step of dueAnchorSteps(proposal, status, document, publication, now)) {
      if (!isStaleDue(step, proposal, document, publication, now)) continue;
      const since = dueSince(step, proposal, document, publication);
      if (since === null) continue;
      alerts.push({
        proposalId: proposal.id, number: proposal.number, title: proposal.title,
        step, kind: "stale", dueSince: new Date(since).toISOString(),
      });
    }
    if (copyGraceReminderDue(proposal, status, document, publication, now) && document) {
      alerts.push({
        proposalId: proposal.id, number: proposal.number, title: proposal.title,
        step: AnchorStep.Closed, kind: "copy_grace", dueSince: document.frozenAt,
      });
    }
  }
  return alerts.sort((a, b) => a.number - b.number || a.step.localeCompare(b.step) || a.kind.localeCompare(b.kind));
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

async function loadCommunityAnchorContext(communityId: string): Promise<{
  candidates: Awaited<ReturnType<typeof loadAnchorCandidates>>;
  documents: Awaited<ReturnType<typeof loadFrozenDocuments>>;
  publication: AnchorPublication;
}> {
  const candidates = await loadAnchorCandidates(communityId);
  if (candidates.length === 0) {
    return { candidates, documents: new Map(), publication: { documentStore: null, documentStoreSince: null } };
  }
  const [documents, settings] = await Promise.all([
    loadFrozenDocuments(candidates.map((p) => p.id)),
    loadGovernanceCommunitySettings(communityId),
  ]);
  return {
    candidates,
    documents,
    publication: { documentStore: settings.documentStore, documentStoreSince: settings.documentStoreSince },
  };
}

function documentOf(
  documents: Awaited<ReturnType<typeof loadFrozenDocuments>>,
  proposalId: string,
): AnchorDocument | null {
  const frozen = documents.get(proposalId);
  return frozen
    ? { hash: frozen.hash, frozenAt: frozen.frozen_at, copies: frozen.proposal_document_copies }
    : null;
}
