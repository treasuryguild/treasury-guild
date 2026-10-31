// Resolve pool tickers for stake transaction titles on the Treasury list
// (browser → /api/chain/stake-pools). Pure title rewriting lives in txDescription.
import { apiFetch } from "@/lib/api/client";
import type { StakePoolsResponse } from "@/lib/api/types";
import type { TransactionSummary } from "@/lib/db/types";
import { displayTxDescription, poolIdsNeedingTicker } from "@/lib/txDescription";

/** Seed from stored `poolTicker`, then look up any remaining pool ids via Koios. */
export async function labelStakeTxDescriptions(
  txs: TransactionSummary[],
  fallbackTreasuryId: string | undefined,
): Promise<TransactionSummary[]> {
  if (txs.length === 0) return txs;

  const tickers = new Map<string, string>();
  for (const tx of txs) {
    const action = tx.governance_action;
    if (action?.kind === "stake" && action.poolId && action.poolTicker?.trim()) {
      tickers.set(action.poolId, action.poolTicker.trim());
    }
  }

  const needed = poolIdsNeedingTicker(txs);
  if (needed.length === 0) {
    return txs.map((tx) => ({
      ...tx,
      description: displayTxDescription(tx, tickers),
    }));
  }

  // Prefer the stake tx's own treasury for network; fall back when listing.
  const treasuryByPool = new Map<string, string>();
  for (const tx of txs) {
    const action = tx.governance_action;
    if (action?.kind !== "stake" || !action.poolId) continue;
    if (!needed.includes(action.poolId)) continue;
    if (!treasuryByPool.has(action.poolId)) {
      treasuryByPool.set(action.poolId, tx.treasury_id || fallbackTreasuryId || "");
    }
  }

  await Promise.all(
    needed.map(async (poolId) => {
      const treasuryId = treasuryByPool.get(poolId) || fallbackTreasuryId;
      if (!treasuryId) return;
      try {
        const params = new URLSearchParams({ treasuryId, poolId, limit: "1" });
        const res = await apiFetch<StakePoolsResponse>(`/api/chain/stake-pools?${params}`);
        const match = res.pools.find((p) => p.poolId === poolId && p.ticker) ?? res.pools[0];
        if (match?.ticker) tickers.set(poolId, match.ticker);
      } catch {
        /* leave unresolved — title falls back to pool id */
      }
    }),
  );

  return txs.map((tx) => ({
    ...tx,
    description: displayTxDescription(tx, tickers),
  }));
}
