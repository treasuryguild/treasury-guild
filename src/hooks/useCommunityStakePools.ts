"use client";

import { browserClient } from "@/lib/supabase/browser";
import {
  COMMUNITY_STAKE_POOL_COLUMNS,
  STAKE_POOL_WALLET_COLUMNS,
  type CommunityStakePoolRow,
  type StakePoolWalletRow,
} from "@/lib/db/types";
import { useAsyncData, type AsyncData } from "./useAsyncData";

export function activeCommunityStakePools(
  list: readonly CommunityStakePoolRow[] | null | undefined,
): CommunityStakePoolRow[] {
  return (list ?? []).filter((p) => !p.archived_at);
}

/** Linked stake pools for a community (RLS member read). */
export function useCommunityStakePools(
  communityId: string | null | undefined,
): AsyncData<CommunityStakePoolRow[]> {
  return useAsyncData(communityId, async () => {
    const { data, error } = await browserClient()
      .from("community_stake_pools")
      .select(COMMUNITY_STAKE_POOL_COLUMNS)
      .eq("community_id", communityId)
      .order("created_at");
    if (error) throw new Error(error.message);
    return (data ?? []) as CommunityStakePoolRow[];
  });
}

/** Role mappings for one linked pool. */
export function useStakePoolWallets(
  stakePoolId: string | null | undefined,
): AsyncData<StakePoolWalletRow[]> {
  return useAsyncData(stakePoolId, async () => {
    const { data, error } = await browserClient()
      .from("stake_pool_wallets")
      .select(STAKE_POOL_WALLET_COLUMNS)
      .eq("stake_pool_id", stakePoolId)
      .order("created_at");
    if (error) throw new Error(error.message);
    return (data ?? []) as StakePoolWalletRow[];
  });
}
