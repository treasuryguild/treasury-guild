// Poll a watched float wallet address: record inflows and outs into
// float_incoming_txs / float_external_txs. No confirmTransaction, no chain
// import — floats are never signable treasuries.
import "server-only";

import { addressTxs, txInfoBulk, type KoiosAddressTx } from "@/lib/cardano/koios";
import { asNetwork } from "@/lib/config";
import { PgCode } from "@/lib/constants";
import { check, maybe, serviceClient } from "@/lib/db/client";
import { classifyPoolRewardInflows, tagFloatTransfers } from "@/lib/db/floatWallets";
import {
  isIncomingTx,
  otherOutputAddresses,
  otherOutputAssets,
  otherOutputSum,
  treasuryOutputAssets,
  treasuryOutputSum,
} from "./pollRules";

export interface FloatPollResult {
  newIncoming: number;
  newExternal: number;
}

async function upsertFloatCursor(
  db: ReturnType<typeof serviceClient>,
  floatWalletId: string,
  lastBlockHeight: number,
): Promise<void> {
  check(
    await db.from("float_sync_cursors").upsert({
      float_wallet_id: floatWalletId,
      last_block_height: lastBlockHeight,
      synced_at: new Date().toISOString(),
    }),
    "save float sync cursor",
  );
}

export async function pollFloatWallet(float: {
  id: string;
  community_id: string;
  address: string;
  /** Community network (0 preprod, 1 mainnet). */
  network: number;
}): Promise<FloatPollResult> {
  const db = serviceClient();
  const network = asNetwork(float.network);

  const cursorRow = maybe<{ last_block_height: number }>(
    await db
      .from("float_sync_cursors")
      .select("last_block_height")
      .eq("float_wallet_id", float.id)
      .maybeSingle(),
    "load float sync cursor",
  );
  const cursor = cursorRow?.last_block_height ?? 0;

  const txs = await addressTxs(network, float.address, cursor);
  if (txs.length === 0) {
    await upsertFloatCursor(db, float.id, cursor);
    return { newIncoming: 0, newExternal: 0 };
  }

  const infos = await txInfoBulk(
    network,
    txs.map((t) => t.tx_hash),
  );
  const infoByHash = new Map(infos.map((i) => [i.tx_hash, i]));

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

    if (!isIncomingTx(info, float.address)) {
      const { error } = await db.from("float_external_txs").insert({
        tx_hash: t.tx_hash,
        float_wallet_id: float.id,
        block_height: t.block_height,
        block_time: new Date(info.tx_timestamp * 1000).toISOString(),
        fee_lovelace: info.fee ?? "0",
        amount_lovelace: otherOutputSum(info, float.address).toString(),
        assets: otherOutputAssets(info, float.address),
        to_addresses: otherOutputAddresses(info, float.address),
      });
      if (!error) newExternal += 1;
      else if (error.code !== PgCode.UniqueViolation) {
        console.error(`float_external_txs insert ${t.tx_hash} failed`, error);
      }
      continue;
    }

    const amount = treasuryOutputSum(info, float.address);
    if (amount <= 0n) continue;

    const inputAddresses = info.inputs.map((i) => i.payment_addr.bech32);
    const { error } = await db.from("float_incoming_txs").insert({
      tx_hash: t.tx_hash,
      float_wallet_id: float.id,
      from_addresses: [...new Set(inputAddresses)],
      amount_lovelace: amount.toString(),
      assets: treasuryOutputAssets(info, float.address),
      block_time: new Date(info.tx_timestamp * 1000).toISOString(),
    });
    if (!error) newIncoming += 1;
    else if (error.code !== PgCode.UniqueViolation) {
      console.error(`float_incoming_txs insert ${t.tx_hash} failed`, error);
    }
  }

  if (newIncoming + newExternal > 0) {
    await tagFloatTransfers(float.community_id);
    await classifyPoolRewardInflows(float.community_id);
  }

  if (undescribed.length > 0) {
    console.warn(
      `float ${float.id}: Koios listed but did not describe ${undescribed.map((t) => t.tx_hash).join(", ")}; the cursor waits for them`,
    );
    maxBlock = Math.max(cursor, Math.min(maxBlock, ...undescribed.map((t) => t.block_height)));
  }
  await upsertFloatCursor(db, float.id, maxBlock);

  return { newIncoming, newExternal };
}
