// The external_txs rows the outside-spend alert (0059) works through: outgoing
// transactions no app build produced, once the chain import is done with
// them (no Guild Vault record to import, or a decided import status), not yet
// announced or dismissed.
import "server-only";

import { check, relation, rows, serviceClient } from "./client";
import type { ExternalTxRow } from "./types";

export type UnalertedSpend = Pick<
  ExternalTxRow, "tx_hash" | "treasury_id" | "block_time" | "amount_lovelace" | "assets" | "to_addresses" | "to_treasury_id"
> & { treasuries: { name: string; network: number; community_id: string } };

export async function listUnalertedSpends(limit = 50): Promise<UnalertedSpend[]> {
  return rows<UnalertedSpend>(
    await serviceClient()
      .from("external_txs")
      // external_txs has two FKs to treasuries (to_treasury_id too): the embed names the paying one.
      .select("tx_hash, treasury_id, block_time, amount_lovelace, assets, to_addresses, to_treasury_id, treasuries!external_txs_treasury_id_fkey!inner(name, network, community_id)")
      .is("governance_alerted_at", null)
      .or("payout_meta.is.null,import_status.not.is.null")
      .order("block_time")
      .limit(limit),
    "load unalerted spends",
  ).map((row) => ({ ...row, treasuries: relation(row.treasuries) }));
}

/** Announced, or decided never to be: either way the row is done with. */
export async function markSpendAlerted(txHashes: readonly string[]): Promise<void> {
  if (txHashes.length === 0) return;
  check(
    await serviceClient().from("external_txs").update({ governance_alerted_at: new Date().toISOString() })
      .in("tx_hash", [...txHashes]),
    "mark spends alerted",
  );
}
