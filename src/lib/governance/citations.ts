// Which decisions a spend cites (the `g` key of the payout and payment
// records): the proposal that created a task, and the budget proposal that
// set the budget its period counts against (`budgetInForce`). Pure and
// client-safe; the build routes resolve ids to numbers and hashes.

import type { Citation } from "@/lib/cardano/metadata";
import { dedupeCitations } from "@/lib/cardano/metadata";

export interface CitedProposal {
  number: number;
  content_hash: string;
}

/** The citations of these proposal ids, unknown or null ids skipped, one per proposal. */
export function citationsOf(
  proposalIds: readonly (string | null | undefined)[],
  proposals: ReadonlyMap<string, CitedProposal>,
): Citation[] {
  const found: Citation[] = [];
  for (const id of proposalIds) {
    const p = id ? proposals.get(id) : undefined;
    if (p) found.push({ number: p.number, contentHash: p.content_hash });
  }
  return dedupeCitations(found);
}
