// Book stake-pool operator rewards as incoming_txs revenue (migration 0099).
import "server-only";

import { PgCode } from "@/lib/constants";
import type { PoolRewardClassification } from "@/lib/stakePools/classify";
import { check, serviceClient } from "./client";

/**
 * Insert (or no-op on conflict) an incoming revenue row for a stake withdraw
 * that never appears as a normal payment-address inflow.
 */
export async function recordPoolRewardIncoming(input: {
  txHash: string;
  treasuryId: string;
  blockTime: string | null;
  classification: PoolRewardClassification;
}): Promise<boolean> {
  const { error } = await serviceClient().from("incoming_txs").insert({
    tx_hash: input.txHash,
    treasury_id: input.treasuryId,
    from_addresses: [],
    amount_lovelace: input.classification.amountLovelace,
    assets: null,
    block_time: input.blockTime,
    incoming_type: "revenue",
    funding_source_id: input.classification.fundingSourceId,
    stake_pool_id: input.classification.stakePoolId,
    requires_reconciliation: false,
    matched: true,
  });
  if (!error) return true;
  if (error.code === PgCode.UniqueViolation) {
    // Already recorded (ordinary inflow or a prior companion row): promote if still open.
    check(
      await serviceClient()
        .from("incoming_txs")
        .update({
          incoming_type: "revenue",
          funding_source_id: input.classification.fundingSourceId,
          stake_pool_id: input.classification.stakePoolId,
          requires_reconciliation: false,
          matched: true,
        })
        .eq("tx_hash", input.txHash)
        .eq("treasury_id", input.treasuryId)
        .is("stake_pool_id", null)
        .in("incoming_type", ["unclassified", "transfer", "revenue"]),
      "tag existing inflow as pool reward",
    );
    return false;
  }
  console.error(`pool reward incoming ${input.txHash} failed`, error);
  return false;
}

/** Tag a freshly polled ordinary inflow that carried a matching withdrawal. */
export async function tagIncomingAsPoolReward(
  txHash: string,
  treasuryId: string,
  classification: PoolRewardClassification,
): Promise<void> {
  check(
    await serviceClient()
      .from("incoming_txs")
      .update({
        incoming_type: "revenue",
        funding_source_id: classification.fundingSourceId,
        stake_pool_id: classification.stakePoolId,
        requires_reconciliation: false,
        matched: true,
      })
      .eq("tx_hash", txHash)
      .eq("treasury_id", treasuryId)
      .is("stake_pool_id", null)
      .neq("incoming_type", "refund"),
    "tag incoming as pool reward",
  );
}
