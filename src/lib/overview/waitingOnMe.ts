// Pending transactions whose signing path includes the wallet and that the
// wallet has neither signed nor rejected — the overview "waiting on you" filter.
import { pathParticipants, pathRule, type PathSigner, type PathTreasury } from "@/lib/cardano/spendingPaths";
import type { SpendingPath } from "@/lib/constants";

export interface WaitingOnMeTx {
  id: string;
  treasury_id: string;
  spending_path: SpendingPath;
  signed_addresses: string[];
  rejected_addresses: string[];
}

export type WaitingOnMeTreasury = PathTreasury & { id: string };

/** Pending txs the wallet still needs to act on, oldest first. */
export function txsWaitingOnMe(
  txs: readonly WaitingOnMeTx[],
  treasuries: readonly WaitingOnMeTreasury[],
  signers: readonly (PathSigner & { treasury_id: string })[],
  wallet: string,
): WaitingOnMeTx[] {
  const byId = new Map(treasuries.map((t) => [t.id, t]));
  const waiting: WaitingOnMeTx[] = [];
  for (const tx of txs) {
    if (tx.signed_addresses.includes(wallet) || tx.rejected_addresses.includes(wallet)) continue;
    const treasury = byId.get(tx.treasury_id);
    if (!treasury) continue;
    const ofTreasury = signers.filter((s) => s.treasury_id === tx.treasury_id);
    const rule = pathRule(treasury, ofTreasury, tx.spending_path);
    if (!pathParticipants(rule).includes(wallet)) continue;
    waiting.push(tx);
  }
  return waiting;
}
