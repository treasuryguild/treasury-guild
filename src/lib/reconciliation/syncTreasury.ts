// One treasury's chain sync, as the sweep and the on-visit sync both run it:
// poll the address, then import what the poll (or an earlier one) recorded as
// external but carries a Treasury Guild record. The import also runs when the
// poll found nothing new: that is how rows recorded before it existed, and
// rows that failed transiently, get their turn. After import, unclassified
// external rows are titled from certificates / CIP-0146 metadata.
import "server-only";

import { importExternalTxs } from "@/lib/chainImport/run";
import { classifyUnlabeledExternalTxs } from "./classifyExternal";
import { pollTreasury, type PollResult } from "./poll";

// A type alias (not an interface) so the route wrapper's JSON type accepts it.
export type TreasurySyncResult = PollResult & {
  /** External transactions imported as payouts or payments this run. */
  imported: number;
  /** External transactions newly held for an admin this run. */
  importBlocked: number;
  /** External rows whose activity was classified (or confirmed empty) this run. */
  classified: number;
};

export async function syncTreasury(treasury: {
  id: string;
  community_id: string;
  address: string;
  network: number;
}): Promise<TreasurySyncResult> {
  const polled = await pollTreasury(treasury);
  let imported = 0;
  let importBlocked = 0;
  try {
    const run = await importExternalTxs(treasury);
    imported = run.imported.length;
    importBlocked = run.blocked.length;
  } catch (err) {
    // The poll's result stands; the import is retried on the next sync.
    console.error(`chain import for treasury ${treasury.id} failed`, err);
  }

  let classified = 0;
  try {
    classified = (await classifyUnlabeledExternalTxs(treasury)).classified;
  } catch (err) {
    console.error(`external activity classify for treasury ${treasury.id} failed`, err);
  }

  return { ...polled, imported, importBlocked, classified };
}
