// Resolve pool tickers and DRep givenNames for stake transaction titles on the
// Treasury list (browser → /api/chain/stake-pools and /api/chain/dreps). Pure
// title rewriting lives in txDescription.
import { apiFetch } from "@/lib/api/client";
import type { DrepsResponse, StakePoolsResponse } from "@/lib/api/types";
import type { ExternalTxRow, TransactionSummary } from "@/lib/db/types";
import { StakeAction, TxKind } from "@/lib/constants";
import {
  parseExternalActivity,
  type ExternalActivity,
} from "@/lib/externalActivity";
import {
  dRepIdsNeedingName,
  displayTxDescription,
  poolIdsNeedingTicker,
} from "@/lib/txDescription";

async function lookupPoolTickers(
  needed: readonly string[],
  treasuryById: ReadonlyMap<string, string>,
  fallbackTreasuryId: string | undefined,
  into: Map<string, string>,
): Promise<void> {
  await Promise.all(
    needed.map(async (poolId) => {
      const treasuryId = treasuryById.get(poolId) || fallbackTreasuryId;
      if (!treasuryId) return;
      try {
        const params = new URLSearchParams({ treasuryId, poolId, limit: "1" });
        const res = await apiFetch<StakePoolsResponse>(`/api/chain/stake-pools?${params}`);
        const match = res.pools.find((p) => p.poolId === poolId && p.ticker) ?? res.pools[0];
        if (match?.ticker) into.set(poolId, match.ticker);
      } catch {
        /* leave unresolved — title falls back to pool id */
      }
    }),
  );
}

async function lookupDrepNames(
  needed: readonly string[],
  treasuryById: ReadonlyMap<string, string>,
  fallbackTreasuryId: string | undefined,
  into: Map<string, string>,
): Promise<void> {
  await Promise.all(
    needed.map(async (dRepId) => {
      const treasuryId = treasuryById.get(dRepId) || fallbackTreasuryId;
      if (!treasuryId) return;
      try {
        const params = new URLSearchParams({ treasuryId, dRepId, limit: "1" });
        const res = await apiFetch<DrepsResponse>(`/api/chain/dreps?${params}`);
        const match =
          res.dreps.find((d) => d.dRepId === dRepId && d.givenName) ?? res.dreps[0];
        if (match?.givenName) into.set(dRepId, match.givenName);
      } catch {
        /* leave unresolved — title falls back to dRep id */
      }
    }),
  );
}

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
    lookupPoolTickers(neededPools, treasuryByPool, fallbackTreasuryId, tickers),
    lookupDrepNames(neededDreps, treasuryByDrep, fallbackTreasuryId, dRepNames),
  ]);

  return txs.map((tx) => ({
    ...tx,
    description: displayTxDescription(tx, {
      poolTickerById: tickers,
      dRepNameById: dRepNames,
    }),
  }));
}

/** Fill pool tickers / DRep names on classified external stake activity. */
export async function labelExternalStakeActivities(
  rows: ExternalTxRow[],
  fallbackTreasuryId: string | undefined,
): Promise<ExternalTxRow[]> {
  if (rows.length === 0) return rows;

  type StakeRow = { row: ExternalTxRow; activity: Extract<ExternalActivity, { kind: typeof TxKind.Stake }> };
  const stakeRows: StakeRow[] = [];
  for (const row of rows) {
    const activity = parseExternalActivity(row.activity);
    if (activity?.kind === TxKind.Stake) stakeRows.push({ row, activity });
  }
  if (stakeRows.length === 0) return rows;

  const tickers = new Map<string, string>();
  const dRepNames = new Map<string, string>();
  const neededPools: string[] = [];
  const neededDreps: string[] = [];
  const treasuryByPool = new Map<string, string>();
  const treasuryByDrep = new Map<string, string>();

  for (const { row, activity } of stakeRows) {
    if (activity.poolId?.trim()) {
      if (activity.poolTicker?.trim()) tickers.set(activity.poolId, activity.poolTicker.trim());
      else if (!neededPools.includes(activity.poolId)) {
        neededPools.push(activity.poolId);
        treasuryByPool.set(activity.poolId, row.treasury_id || fallbackTreasuryId || "");
      }
    }
    if (
      activity.action === StakeAction.VoteDelegation &&
      activity.dRepId?.trim() &&
      activity.dRepId !== "always_abstain" &&
      activity.dRepId !== "always_no_confidence"
    ) {
      if (activity.dRepName?.trim()) dRepNames.set(activity.dRepId, activity.dRepName.trim());
      else if (!neededDreps.includes(activity.dRepId)) {
        neededDreps.push(activity.dRepId);
        treasuryByDrep.set(activity.dRepId, row.treasury_id || fallbackTreasuryId || "");
      }
    }
  }

  await Promise.all([
    lookupPoolTickers(neededPools, treasuryByPool, fallbackTreasuryId, tickers),
    lookupDrepNames(neededDreps, treasuryByDrep, fallbackTreasuryId, dRepNames),
  ]);

  if (tickers.size === 0 && dRepNames.size === 0) return rows;

  return rows.map((row) => {
    const activity = parseExternalActivity(row.activity);
    if (activity?.kind !== TxKind.Stake) return row;
    const poolTicker =
      activity.poolTicker?.trim() ||
      (activity.poolId ? tickers.get(activity.poolId) : null) ||
      null;
    const dRepName =
      activity.dRepName?.trim() ||
      (activity.dRepId ? dRepNames.get(activity.dRepId) : null) ||
      null;
    if (!poolTicker && !dRepName) return row;
    return {
      ...row,
      activity: { ...activity, poolTicker, dRepName },
    };
  });
}
