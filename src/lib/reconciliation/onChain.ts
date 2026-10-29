// Confirm a pending or submitted transaction whose hash is already on-chain
// (broadcast outside the app's submit path). Shared by the poller and the
// delete / reject routes so neither releases queued tasks for a spent tx.
import "server-only";

import { txInfoBulk } from "@/lib/cardano/koios";
import type { Network } from "@/lib/config";
import { TxState } from "@/lib/constants";
import { confirmTransaction } from "@/lib/db/transactions";

/**
 * Look the hash up on Koios and, when found, confirm the row (and pay its
 * tasks). Returns true when the confirmation ran; false when the hash is
 * absent from the chain or the row moved on.
 */
export async function confirmIfOnChain(
  tx: { id: string; tx_hash: string | null; state: number },
  network: Network,
): Promise<boolean> {
  if (!tx.tx_hash) return false;
  if (tx.state !== TxState.Pending && tx.state !== TxState.Submitted) return false;
  const infos = await txInfoBulk(network, [tx.tx_hash]);
  const info = infos[0];
  if (!info || info.tx_hash !== tx.tx_hash) return false;
  return confirmTransaction(tx.id, new Date(info.tx_timestamp * 1000).toISOString());
}
