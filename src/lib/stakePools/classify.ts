// Pure matching for community stake-pool reward income (migration 0099).

export interface PoolRewardMatchTarget {
  id: string;
  fundingSourceId: string;
  /** Stake addresses whose withdrawals count as this pool's rewards. */
  rewardAddresses: readonly string[];
  /**
   * When non-empty, only these treasuries auto-book income for this pool.
   * Empty means any treasury of the community may book a matching withdraw.
   */
  treasuryIds: readonly string[];
}

export interface PoolRewardClassification {
  stakePoolId: string;
  fundingSourceId: string;
  /** Lovelace withdrawn that should be booked as revenue. */
  amountLovelace: string;
}

/**
 * Match Koios withdrawals against linked community pools. Returns the first
 * matching pool for the receiving treasury, or null when nothing matches.
 */
export function classifyPoolRewardWithdraw(input: {
  treasuryId: string;
  withdrawals: readonly { stakeAddr: string; amount: string }[];
  pools: readonly PoolRewardMatchTarget[];
}): PoolRewardClassification | null {
  const byAddr = new Map<string, PoolRewardMatchTarget>();
  for (const pool of input.pools) {
    if (pool.treasuryIds.length > 0 && !pool.treasuryIds.includes(input.treasuryId)) {
      continue;
    }
    for (const addr of pool.rewardAddresses) {
      if (addr) byAddr.set(addr, pool);
    }
  }
  if (byAddr.size === 0) return null;

  let matched: PoolRewardMatchTarget | null = null;
  let total = 0n;
  for (const w of input.withdrawals) {
    const pool = byAddr.get(w.stakeAddr);
    if (!pool) continue;
    const amount = BigInt(w.amount || "0");
    if (amount <= 0n) continue;
    if (matched && matched.id !== pool.id) continue;
    matched = pool;
    total += amount;
  }
  if (!matched || total <= 0n) return null;
  return {
    stakePoolId: matched.id,
    fundingSourceId: matched.fundingSourceId,
    amountLovelace: total.toString(),
  };
}

/** Whether a float→treasury transfer should become pool revenue (RPC twin). */
export function isPoolRewardsBufferPurpose(purpose: string | null | undefined): boolean {
  return purpose === "pool_rewards";
}
