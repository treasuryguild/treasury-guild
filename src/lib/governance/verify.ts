// Comparing a proposal's frozen tally document with its on-chain anchors
// (docs/onchain-anchoring-estimate.md, phase 4): the proposed anchor must
// carry the document's content and rules fingerprints, the opened anchor the
// hash of its voter list, the closed anchor its final state and the document's
// own hash. Pure and client-safe: the proposal page's Verify button runs it
// in the browser on records read from the chain.
import { AnchorStep, ANCHOR_STEPS } from "@/lib/constants";
import type { AnchorEntry, AnchorMetadata } from "@/lib/cardano/anchorMetadata";
import type { TallyDocument } from "./tallyDocument";

/** One confirmed anchor as read from the chain. */
export interface VerifiedAnchor {
  step: AnchorStep;
  txHash: string;
  /** When the chain included the transaction, if known. */
  blockTime: string | null;
  /** The transaction's decoded label-190002 record; null when it carries none. */
  record: AnchorMetadata | null;
}

export interface AnchorComparison {
  /** Every mismatch found; empty when the document matches the chain. */
  problems: string[];
  /** Whether the proposed and opened anchors both landed before voting opened; null when the timing cannot be told. */
  anchoredBeforeVoting: boolean | null;
  /** The steps found on-chain. */
  found: AnchorStep[];
}

const STEP_NAMES: Record<AnchorStep, string> = { proposed: "proposed", opened: "opened", closed: "closed" };

function entryFor(anchor: VerifiedAnchor, number: number): AnchorEntry | null {
  return anchor.record?.a.find((e) => e[0] === number && e[1] === anchor.step) ?? null;
}

/**
 * Compare the frozen document with the anchors of its proposal. `electorateHash`
 * is the hash recomputed from the document's voter list (electorateHash.ts),
 * so the opened anchor is checked against the list itself, not a stored value.
 */
export function compareAnchors(
  doc: TallyDocument,
  anchors: readonly VerifiedAnchor[],
  electorateHash: string | null,
): AnchorComparison {
  const p = doc.body.proposal;
  const problems: string[] = [];
  const found: AnchorStep[] = [];
  const landed: Partial<Record<AnchorStep, string | null>> = {};

  for (const step of ANCHOR_STEPS) {
    const anchor = anchors.find((a) => a.step === step);
    if (!anchor) continue;
    const entry = entryFor(anchor, p.number);
    if (!entry) {
      problems.push(`The ${STEP_NAMES[step]} anchor (${anchor.txHash}) carries no entry for proposal #${p.number}`);
      continue;
    }
    found.push(step);
    landed[step] = anchor.blockTime;
    if (anchor.record && anchor.record.c !== doc.body.community) {
      problems.push(`The ${STEP_NAMES[step]} anchor names the community "${anchor.record.c}", not "${doc.body.community}"`);
    }
    switch (entry[1]) {
      case AnchorStep.Proposed:
        if (entry[2] !== p.contentHash) problems.push("The proposed anchor's content fingerprint differs from the document's");
        if (entry[3] !== p.rulesHash) problems.push("The proposed anchor's rules fingerprint differs from the document's");
        break;
      case AnchorStep.Opened:
        if (electorateHash === null) problems.push("The opened anchor carries a voter-list fingerprint, but the document has none");
        else if (entry[2] !== electorateHash) problems.push("The opened anchor's voter-list fingerprint differs from the document's voter list");
        break;
      case AnchorStep.Closed:
        if (entry[2] !== p.state) problems.push(`The closed anchor says ${entry[2]}, the document ${p.state}`);
        if (entry.length >= 5) {
          if (entry[3] !== doc.hash) problems.push("The closed anchor's record hash differs from the document's hash");
          const [electorate, ballots] = entry[4]!;
          if (p.tally && (electorate !== p.tally.electorate || ballots !== p.tally.ballots)) {
            problems.push("The closed anchor's counts differ from the document's tally");
          }
        } else if (p.tally) {
          problems.push("The closed anchor carries no record hash, but the proposal reached a vote");
        }
        break;
    }
  }

  const opened = p.votingOpenedAt ? Date.parse(p.votingOpenedAt) : null;
  const first = [landed.proposed, landed.opened];
  const anchoredBeforeVoting = opened === null || first.some((t) => t === undefined || t === null)
    ? null
    : first.every((t) => Date.parse(t!) <= opened);
  return { problems, anchoredBeforeVoting, found };
}
