// Treasury polling: record incoming (refund) txs, confirm submitted payouts,
// and record outgoing txs the app has no transactions row for (external_txs).
import "server-only";

import { check, maybe, rows, serviceClient } from "@/lib/db/client";
import { addressTxs, txInfoBulk, type KoiosAddressTx } from "@/lib/cardano/koios";
import { asNetwork } from "@/lib/config";
import { PgCode, TxState } from "@/lib/constants";
import { confirmTransaction } from "@/lib/db/transactions";
import { tagInternalTransfers } from "@/lib/db/treasuries";
import {
  isIncomingTx,
  otherOutputAddresses,
  otherOutputAssets,
  otherOutputSum,
  payoutMetaOf,
  treasuryOutputAssets,
  treasuryOutputSum,
} from "./pollRules";

export interface PollResult {
  newIncoming: number;
  confirmed: number;
  /** Outgoing txs recorded in external_txs this poll. */
  newExternal: number;
}

/** Advance the cursor and stamp the poll time, even when nothing new arrived. */
async function upsertCursor(
  db: ReturnType<typeof serviceClient>,
  treasuryId: string,
  lastBlockHeight: number,
): Promise<void> {
  check(
    await db.from("treasury_sync_cursors").upsert({
      treasury_id: treasuryId,
      last_block_height: lastBlockHeight,
      synced_at: new Date().toISOString(),
    }),
    "save sync cursor",
  );
}

export async function pollTreasury(treasury: {
  id: string;
  community_id: string;
  address: string;
  network: number;
}): Promise<PollResult> {
  const db = serviceClient();
  const network = asNetwork(treasury.network);

  const cursorRow = maybe<{ last_block_height: number }>(
    await db
      .from("treasury_sync_cursors")
      .select("last_block_height")
      .eq("treasury_id", treasury.id)
      .maybeSingle(),
    "load sync cursor",
  );
  const cursor = cursorRow?.last_block_height ?? 0;

  const txs = await addressTxs(network, treasury.address, cursor);
  if (txs.length === 0) {
    await upsertCursor(db, treasury.id, cursor);
    return { newIncoming: 0, confirmed: 0, newExternal: 0 };
  }

  const infos = await txInfoBulk(
    network,
    txs.map((t) => t.tx_hash),
  );
  const infoByHash = new Map(infos.map((i) => [i.tx_hash, i]));

  // Every hash the app built for this treasury, whatever its state: those are
  // never external. (A whole treasury's rows, not `.in(hashes)`: a history
  // walk can carry thousands of hashes, too many for a query string.)
  // A failed read must not look empty: the app's own txs would be recorded as external.
  const knownRows = rows<{ tx_hash: string }>(
    await db
      .from("transactions")
      .select("tx_hash")
      .eq("treasury_id", treasury.id)
      .not("tx_hash", "is", null),
    "load known tx hashes",
  );
  const known = new Set(knownRows.map((r) => r.tx_hash));

  // Confirm our own pending, submitted or canceled txs that are now on-chain.
  // Pending covers a fully signed CBOR broadcast outside the app's submit
  // path; canceled covers the same after cancel freed the pending slot.
  const awaiting = rows<{ id: string; tx_hash: string | null }>(
    await db
      .from("transactions")
      .select("id, tx_hash")
      .eq("treasury_id", treasury.id)
      .in("state", [TxState.Pending, TxState.Submitted, TxState.Canceled]),
    "load pending, submitted and canceled txs",
  );
  let confirmed = 0;
  for (const tx of awaiting) {
    const info = tx.tx_hash ? infoByHash.get(tx.tx_hash) : undefined;
    if (tx.tx_hash && info) {
      // One database step: the row, its payouts and its tasks (paid, with the
      // confirming hash, native ones moved to the Paid column). The block time
      // lets a proposal anchor be shown beside the time voting opened. False:
      // another poll confirmed it first.
      if (await confirmTransaction(tx.id, new Date(info.tx_timestamp * 1000).toISOString())) confirmed += 1;
    }
  }

  // Record incoming txs: treasury in outputs but NOT among input addresses.
  // Txs that spend from the treasury are either the app's own (known hash)
  // or external: built elsewhere, or the app lost the row — recorded so the
  // Treasury page shows the wallet's real history.
  let newIncoming = 0;
  let newExternal = 0;
  let maxBlock = cursor;
  const undescribed: KoiosAddressTx[] = [];
  for (const t of txs) {
    const info = infoByHash.get(t.tx_hash);
    if (!info) {
      undescribed.push(t);
      continue;
    }
    if (t.block_height > maxBlock) maxBlock = t.block_height;
    if (!isIncomingTx(info, treasury.address)) {
      if (known.has(t.tx_hash)) continue;
      const { error } = await db.from("external_txs").insert({
        tx_hash: t.tx_hash,
        treasury_id: treasury.id,
        block_height: t.block_height,
        block_time: new Date(info.tx_timestamp * 1000).toISOString(),
        fee_lovelace: info.fee ?? "0",
        amount_lovelace: otherOutputSum(info, treasury.address).toString(),
        assets: otherOutputAssets(info, treasury.address),
        to_addresses: otherOutputAddresses(info, treasury.address),
        payout_meta: payoutMetaOf(info),
      });
      if (!error) newExternal += 1;
      else if (error.code !== PgCode.UniqueViolation) {
        console.error(`external_txs insert ${t.tx_hash} failed`, error);
      }
      continue;
    }

    const amount = treasuryOutputSum(info, treasury.address);
    if (amount <= 0n) continue;

    const inputAddresses = info.inputs.map((i) => i.payment_addr.bech32);
    const { error } = await db.from("incoming_txs").insert({
      tx_hash: t.tx_hash,
      treasury_id: treasury.id,
      from_addresses: [...new Set(inputAddresses)],
      amount_lovelace: amount.toString(),
      assets: treasuryOutputAssets(info, treasury.address),
      block_time: new Date(info.tx_timestamp * 1000).toISOString(),
    });
    if (!error) newIncoming += 1;
    else if (error.code !== PgCode.UniqueViolation) {
      console.error(`incoming_txs insert ${t.tx_hash} failed`, error);
    }
  }

  // Link new rows to the community's other treasuries: an inflow from one is
  // a transfer (no review), an outgoing tx to one is tagged for display.
  if (newIncoming + newExternal > 0) {
    await tagInternalTransfers(treasury.community_id);
  }

  // A hash Koios listed but did not describe (lag, a partial bulk answer) must
  // be listed again: the cursor stops at its block, never past it. Koios'
  // `_after_block_height` is inclusive (checked against preprod, 2026-10-01),
  // so the next poll re-lists that block; rows already recorded hit their
  // unique index above.
  if (undescribed.length > 0) {
    console.warn(
      `treasury ${treasury.id}: Koios listed but did not describe ${undescribed.map((t) => t.tx_hash).join(", ")}; the cursor waits for them`,
    );
    maxBlock = Math.max(cursor, Math.min(maxBlock, ...undescribed.map((t) => t.block_height)));
  }
  await upsertCursor(db, treasury.id, maxBlock);

  return { newIncoming, confirmed, newExternal };
}
