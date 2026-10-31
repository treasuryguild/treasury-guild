// Backfill `external_txs.activity` for rows recorded before the classifier
// (or before Koios certs were requested). Runs after chain import on each
// sync so production rows already labeled "Outgoing transfer" pick up stake /
// registration titles without a manual wipe.
import "server-only";

import { asNetwork } from "@/lib/config";
import { txInfoBulk } from "@/lib/cardano/koios";
import { check, rows, serviceClient } from "@/lib/db/client";
import {
  classifyExternalActivity,
  isRecognizedExternalActivity,
} from "@/lib/externalActivity";

const BACKFILL_LIMIT = 50;

export interface ClassifyExternalResult {
  /** Rows whose activity column was written (including explicit null). */
  classified: number;
}

/**
 * Re-fetch Koios tx_info for this treasury's unclassified external rows and
 * store the classifier result. Recognized kinds also stamp
 * `governance_alerted_at` so Discord never treats them as budget outside-spends.
 */
export async function classifyUnlabeledExternalTxs(treasury: {
  id: string;
  network: number;
}): Promise<ClassifyExternalResult> {
  const db = serviceClient();
  const pending = rows<{ tx_hash: string }>(
    await db
      .from("external_txs")
      .select("tx_hash")
      .eq("treasury_id", treasury.id)
      .is("activity", null)
      .order("block_time", { ascending: false })
      .limit(BACKFILL_LIMIT),
    "load unclassified external txs",
  );
  if (pending.length === 0) return { classified: 0 };

  const infos = await txInfoBulk(
    asNetwork(treasury.network),
    pending.map((r) => r.tx_hash),
  );
  const byHash = new Map(infos.map((i) => [i.tx_hash, i]));
  let classified = 0;

  for (const row of pending) {
    const info = byHash.get(row.tx_hash);
    if (!info) continue;
    const activity = classifyExternalActivity({
      metadata: info.metadata ?? null,
      certificates: info.certificates ?? null,
      withdrawals: info.withdrawals ?? null,
      voting_procedures: info.voting_procedures ?? null,
    });
    // `{}` = looked up, nothing to classify (SQL null stays "not yet checked").
    const patch: Record<string, unknown> = { activity: activity ?? {} };
    if (isRecognizedExternalActivity(activity)) {
      patch.governance_alerted_at = new Date().toISOString();
    }
    check(
      await db.from("external_txs").update(patch).eq("tx_hash", row.tx_hash).eq("treasury_id", treasury.id),
      `classify external ${row.tx_hash}`,
    );
    classified += 1;
  }

  return { classified };
}
