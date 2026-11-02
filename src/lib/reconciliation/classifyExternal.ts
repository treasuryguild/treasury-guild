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
  parseExternalActivity,
} from "@/lib/externalActivity";
import {
  enrichStakeActivityLabels,
  stakeActivityLabelsChanged,
  stakeActivityNeedsLabels,
} from "./externalActivityEnrich";

const BACKFILL_LIMIT = 50;
/** Recent stake rows to scan for missing ticker/name on each sync. */
const LABEL_ENRICH_SCAN = 50;

export interface ClassifyExternalResult {
  /** Rows whose activity column was written (including explicit `{}`). */
  classified: number;
}

export interface EnrichExternalLabelsResult {
  /** Stake rows whose activity gained a ticker or DRep name this run. */
  enriched: number;
}

/**
 * Re-fetch Koios tx_info for this treasury's unclassified external rows and
 * store the classifier result (with stake labels filled when available).
 * Recognized kinds also stamp `governance_alerted_at` so Discord never
 * treats them as budget outside-spends.
 */
export async function classifyUnlabeledExternalTxs(treasury: {
  id: string;
  network: number;
}): Promise<ClassifyExternalResult> {
  const db = serviceClient();
  const network = asNetwork(treasury.network);
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
    network,
    pending.map((r) => r.tx_hash),
  );
  const byHash = new Map(infos.map((i) => [i.tx_hash, i]));
  let classified = 0;

  for (const row of pending) {
    const info = byHash.get(row.tx_hash);
    if (!info) continue;
    const activity = await enrichStakeActivityLabels(
      classifyExternalActivity({
        metadata: info.metadata ?? null,
        certificates: info.certificates ?? null,
        withdrawals: info.withdrawals ?? null,
        voting_procedures: info.voting_procedures ?? null,
      }),
      network,
    );
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

/**
 * Fill missing poolTicker / dRepName on recent stake-shaped activity rows.
 * Production rows classified before labels were persisted upgrade without a
 * details-page click.
 */
export async function enrichIncompleteExternalLabels(treasury: {
  id: string;
  network: number;
}): Promise<EnrichExternalLabelsResult> {
  const db = serviceClient();
  const network = asNetwork(treasury.network);
  // Stake activities are objects with kind; `{}` and null are skipped in JS.
  const candidates = rows<{ tx_hash: string; activity: unknown }>(
    await db
      .from("external_txs")
      .select("tx_hash, activity")
      .eq("treasury_id", treasury.id)
      .not("activity", "is", null)
      .order("block_time", { ascending: false })
      .limit(LABEL_ENRICH_SCAN),
    "load external txs for label enrich",
  );

  let enriched = 0;
  for (const row of candidates) {
    const parsed = parseExternalActivity(row.activity);
    if (!stakeActivityNeedsLabels(parsed)) continue;
    const next = await enrichStakeActivityLabels(parsed, network);
    if (!stakeActivityLabelsChanged(parsed, next)) continue;
    check(
      await db
        .from("external_txs")
        .update({ activity: next })
        .eq("tx_hash", row.tx_hash)
        .eq("treasury_id", treasury.id),
      `enrich external labels ${row.tx_hash}`,
    );
    enriched += 1;
  }

  return { enriched };
}
