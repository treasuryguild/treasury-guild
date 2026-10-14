// Move a proposal along once its time comes: open voting after the
// discussion, record the tally at the deadline, carry out a passed one. The
// reconcile sweep runs this for every due proposal; a proposal page nudges
// its own when a deadline passes while someone is watching. Every step is an
// idempotent RPC that re-checks the clock in SQL, so running it early, twice
// or concurrently is harmless: a refused step is left for the next run.
import "server-only";

import {
  closeProposal, executeProposal, listDueProposalIds, loadProposal, loadProposalChoices, openProposalVoting,
} from "@/lib/db/governance";
import type { ProposalRow } from "@/lib/db/types";
import { ConflictError } from "@/lib/errors";
import { tryFreezeTallyDocument } from "./freeze";
import { dueAction } from "./lifecycle";
import { tallyProposal } from "./tally";

export async function advanceProposal(id: string, now: number = Date.now()): Promise<ProposalRow> {
  // At most open → close → execute.
  for (let step = 0; step < 3; step++) {
    const proposal = await loadProposal(id);
    const action = dueAction(proposal, now);
    if (!action) return proposal;
    try {
      if (action === "open") {
        await openProposalVoting(id);
      } else if (action === "close") {
        // Read the ballots after the row: a ballot in between bumps the
        // version and the close is refused, to be counted again next time.
        const choices = await loadProposalChoices(id);
        await closeProposal(id, proposal.ballot_version, tallyProposal(proposal.rules, proposal.electorate_size ?? 0, choices));
        // The result is final: freeze the tally document now (the sweep
        // repairs a miss), before a passed proposal is carried out.
        await tryFreezeTallyDocument(await loadProposal(id));
      } else {
        await executeProposal(id, null);
      }
    } catch (err) {
      // "Still open" (this clock ahead of the database's) or a ballot race.
      if (err instanceof ConflictError) return loadProposal(id);
      throw err;
    }
  }
  return loadProposal(id);
}

export interface AdvanceSweepResult {
  advanced: number;
  failed: number;
}

export async function advanceDueProposals(now: Date): Promise<AdvanceSweepResult> {
  const result: AdvanceSweepResult = { advanced: 0, failed: 0 };
  for (const id of await listDueProposalIds(now)) {
    try {
      await advanceProposal(id, now.getTime());
      result.advanced += 1;
    } catch (err) {
      console.error(`advanceProposal ${id} failed`, err);
      result.failed += 1;
    }
  }
  return result;
}
