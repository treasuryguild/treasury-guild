// Apply community stake-pool reward classification during treasury polling.
import "server-only";

import type { KoiosTxInfo } from "@/lib/cardano/koios";
import { recordPoolRewardIncoming, tagIncomingAsPoolReward } from "@/lib/db/poolRewardIncome";
import { loadPoolsForRewardMatch } from "@/lib/db/stakePools";
import { classifyPoolRewardWithdraw } from "@/lib/stakePools/classify";

function withdrawalsOf(info: KoiosTxInfo): { stakeAddr: string; amount: string }[] {
  const out: { stakeAddr: string; amount: string }[] = [];
  for (const w of info.withdrawals ?? []) {
    const stakeAddr = typeof w.stake_addr === "string" ? w.stake_addr.trim() : "";
    const amount = typeof w.amount === "string" ? w.amount : "";
    if (!stakeAddr || !amount) continue;
    out.push({ stakeAddr, amount });
  }
  return out;
}

/**
 * If the tx withdraws from a linked pool's reward account, book revenue on
 * the receiving treasury (companion row or tag of an ordinary inflow).
 */
export async function applyPoolRewardIfMatched(input: {
  communityId: string;
  treasuryId: string;
  txHash: string;
  info: KoiosTxInfo;
  /** When true the tx already has an incoming_txs row (ordinary inflow). */
  hasIncomingRow: boolean;
}): Promise<void> {
  const withdrawals = withdrawalsOf(input.info);
  if (withdrawals.length === 0) return;

  const pools = await loadPoolsForRewardMatch(input.communityId);
  if (pools.length === 0) return;

  const classification = classifyPoolRewardWithdraw({
    treasuryId: input.treasuryId,
    withdrawals,
    pools: pools.map((p) => ({
      id: p.id,
      fundingSourceId: p.funding_source_id,
      rewardAddresses: p.rewardAddresses,
      treasuryIds: p.treasuryIds,
    })),
  });
  if (!classification) return;

  const blockTime = new Date(input.info.tx_timestamp * 1000).toISOString();
  if (input.hasIncomingRow) {
    await tagIncomingAsPoolReward(input.txHash, input.treasuryId, classification);
  } else {
    await recordPoolRewardIncoming({
      txHash: input.txHash,
      treasuryId: input.treasuryId,
      blockTime,
      classification,
    });
  }
}
