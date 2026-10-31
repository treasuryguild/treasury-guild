// Resolve pool tickers and DRep givenNames for stake transaction titles on the
// Treasury list (browser → /api/chain/stake-pools and /api/chain/dreps). Pure
// title rewriting lives in txDescription.
import { apiFetch } from "@/lib/api/client";
import type { DrepsResponse, StakePoolsResponse } from "@/lib/api/types";
import type { TransactionSummary } from "@/lib/db/types";
import {
  dRepIdsNeedingName,
  displayTxDescription,
  poolIdsNeedingTicker,
} from "@/lib/txDescription";

/** Seed from stored labels, then look up any remaining ids via Koios proxies. */
export async function labelStakeTxDescriptions(
  txs: TransactionSummary[],
  fallbackTreasuryId: string | undefined,
): Promise<TransactionSummary[]> {
  if (txs.length === 0) return txs;

  const tickers = new Map<string, string>();
  const dRepNames = new Map<string, string>();
  for (const tx of txs) {
    const action = tx.governance_action;
    if (action?.kind === "stake" && action.poolId && action.poolTicker?.trim()) {
      tickers.set(action.poolId, action.poolTicker.trim());
    }
    if (action?.kind === "stake" && action.dRepId && action.dRepName?.trim()) {
      dRepNames.set(action.dRepId, action.dRepName.trim());
    }
  }

  const neededPools = poolIdsNeedingTicker(txs);
  const neededDreps = dRepIdsNeedingName(txs);
  if (neededPools.length === 0 && neededDreps.length === 0) {
    return txs.map((tx) => ({
      ...tx,
      description: displayTxDescription(tx, {
        poolTickerById: tickers,
        dRepNameById: dRepNames,
      }),
    }));
  }

  // Prefer the stake tx's own treasury for network; fall back when listing.
  const treasuryByPool = new Map<string, string>();
  const treasuryByDrep = new Map<string, string>();
  for (const tx of txs) {
    const action = tx.governance_action;
    if (action?.kind !== "stake") continue;
    if (action.poolId && neededPools.includes(action.poolId) && !treasuryByPool.has(action.poolId)) {
      treasuryByPool.set(action.poolId, tx.treasury_id || fallbackTreasuryId || "");
    }
    if (
      action.dRepId &&
      neededDreps.includes(action.dRepId) &&
      !treasuryByDrep.has(action.dRepId)
    ) {
      treasuryByDrep.set(action.dRepId, tx.treasury_id || fallbackTreasuryId || "");
    }
  }

  await Promise.all([
    ...neededPools.map(async (poolId) => {
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
    ...neededDreps.map(async (dRepId) => {
      const treasuryId = treasuryByDrep.get(dRepId) || fallbackTreasuryId;
      if (!treasuryId) return;
      try {
        const params = new URLSearchParams({ treasuryId, dRepId, limit: "1" });
        const res = await apiFetch<DrepsResponse>(`/api/chain/dreps?${params}`);
        const match =
          res.dreps.find((d) => d.dRepId === dRepId && d.givenName) ?? res.dreps[0];
        if (match?.givenName) dRepNames.set(dRepId, match.givenName);
      } catch {
        /* leave unresolved — title falls back to dRep id */
      }
    }),
  ]);

  return txs.map((tx) => ({
    ...tx,
    description: displayTxDescription(tx, {
      poolTickerById: tickers,
      dRepNameById: dRepNames,
    }),
  }));
}
