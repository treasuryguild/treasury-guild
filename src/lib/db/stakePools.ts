// Service-role helpers for community-linked stake pools (migration 0099).
import "server-only";

import type { StakePoolDetail } from "@/lib/cardano/stakePools";
import { MAX_COMMUNITY_STAKE_POOLS, PgCode } from "@/lib/constants";
import { ConflictError, NotFoundError } from "@/lib/errors";
import { check, maybe, must, rows, serviceClient } from "./client";
import { createFundingSource } from "./funding";
import {
  COMMUNITY_STAKE_POOL_COLUMNS,
  STAKE_POOL_WALLET_COLUMNS,
  type CommunityStakePoolRow,
  type StakePoolWalletRole,
  type StakePoolWalletRow,
} from "./types";

const AT_CAP = `A community can link at most ${MAX_COMMUNITY_STAKE_POOLS} stake pools`;
const ALREADY_LINKED = "This community already monitors that stake pool";

export async function loadCommunityStakePool(id: string): Promise<CommunityStakePoolRow | null> {
  return maybe<CommunityStakePoolRow>(
    await serviceClient()
      .from("community_stake_pools")
      .select(COMMUNITY_STAKE_POOL_COLUMNS)
      .eq("id", id)
      .maybeSingle(),
    "load community stake pool",
  );
}

export async function requireCommunityStakePool(id: string): Promise<CommunityStakePoolRow> {
  const row = await loadCommunityStakePool(id);
  if (!row) throw new NotFoundError("Stake pool not found");
  return row;
}

export async function loadCommunityStakePools(communityId: string): Promise<CommunityStakePoolRow[]> {
  return rows<CommunityStakePoolRow>(
    await serviceClient()
      .from("community_stake_pools")
      .select(COMMUNITY_STAKE_POOL_COLUMNS)
      .eq("community_id", communityId)
      .order("created_at"),
    "load community stake pools",
  );
}

export async function loadActiveCommunityStakePools(
  communityId: string,
): Promise<CommunityStakePoolRow[]> {
  return rows<CommunityStakePoolRow>(
    await serviceClient()
      .from("community_stake_pools")
      .select(COMMUNITY_STAKE_POOL_COLUMNS)
      .eq("community_id", communityId)
      .is("archived_at", null)
      .order("created_at"),
    "load active community stake pools",
  );
}

export async function countActiveCommunityStakePools(communityId: string): Promise<number> {
  const res = await serviceClient()
    .from("community_stake_pools")
    .select("id", { count: "exact", head: true })
    .eq("community_id", communityId)
    .is("archived_at", null);
  check(res, "count active community stake pools");
  return res.count ?? 0;
}

export async function loadStakePoolWallets(stakePoolId: string): Promise<StakePoolWalletRow[]> {
  return rows<StakePoolWalletRow>(
    await serviceClient()
      .from("stake_pool_wallets")
      .select(STAKE_POOL_WALLET_COLUMNS)
      .eq("stake_pool_id", stakePoolId)
      .order("created_at"),
    "load stake pool wallets",
  );
}

function fundingSourceName(detail: StakePoolDetail): string {
  const ticker = detail.ticker?.trim();
  if (ticker) return `Pool ${ticker} rewards`.slice(0, 80);
  return `Pool ${detail.poolId.slice(0, 12)}… rewards`.slice(0, 80);
}

function cachedFields(detail: StakePoolDetail, iconUrl: string | null) {
  return {
    pool_id: detail.poolId,
    ticker: detail.ticker,
    margin: detail.margin,
    fixed_cost: detail.fixedCost,
    pledge: detail.pledge,
    active_stake: detail.activeStake,
    pool_status: detail.status,
    reward_address: detail.rewardAddress,
    owners: detail.owners,
    icon_url: iconUrl,
    refreshed_at: new Date().toISOString(),
  };
}

/** Prefill reward_account + owner rows from chain registration. */
function defaultWalletRows(
  stakePoolId: string,
  detail: StakePoolDetail,
): { stake_pool_id: string; role: StakePoolWalletRole; address: string }[] {
  const rows: { stake_pool_id: string; role: StakePoolWalletRole; address: string }[] = [];
  if (detail.rewardAddress) {
    rows.push({
      stake_pool_id: stakePoolId,
      role: "reward_account",
      address: detail.rewardAddress,
    });
  }
  for (const owner of detail.owners) {
    rows.push({ stake_pool_id: stakePoolId, role: "owner", address: owner });
  }
  return rows;
}

export async function createCommunityStakePool(input: {
  community_id: string;
  detail: StakePoolDetail;
  /** Best-effort HTTPS icon from extended metadata; null when unknown. */
  icon_url: string | null;
  created_by: string;
}): Promise<CommunityStakePoolRow> {
  const active = await countActiveCommunityStakePools(input.community_id);
  if (active >= MAX_COMMUNITY_STAKE_POOLS) throw new ConflictError(AT_CAP);

  const source = await createFundingSource({
    community_id: input.community_id,
    name: fundingSourceName(input.detail),
    description: `Operator rewards from stake pool ${input.detail.poolId}`,
    url: null,
    created_by: input.created_by,
  });

  const res = await serviceClient()
    .from("community_stake_pools")
    .insert({
      community_id: input.community_id,
      funding_source_id: source.id,
      created_by: input.created_by,
      ...cachedFields(input.detail, input.icon_url),
    })
    .select(COMMUNITY_STAKE_POOL_COLUMNS)
    .single();
  if (res.error?.code === PgCode.UniqueViolation) throw new ConflictError(ALREADY_LINKED);
  const pool = must<CommunityStakePoolRow>(res, "create community stake pool");

  const prefills = defaultWalletRows(pool.id, input.detail);
  if (prefills.length > 0) {
    check(
      await serviceClient().from("stake_pool_wallets").insert(prefills),
      "prefill stake pool wallets",
    );
  }
  return pool;
}

export async function refreshCommunityStakePool(
  id: string,
  detail: StakePoolDetail,
  iconUrl: string | null,
): Promise<CommunityStakePoolRow> {
  return must<CommunityStakePoolRow>(
    await serviceClient()
      .from("community_stake_pools")
      .update(cachedFields(detail, iconUrl))
      .eq("id", id)
      .select(COMMUNITY_STAKE_POOL_COLUMNS)
      .single(),
    "refresh community stake pool",
  );
}

export async function archiveCommunityStakePool(id: string, archivedBy: string): Promise<void> {
  check(
    await serviceClient()
      .from("community_stake_pools")
      .update({ archived_at: new Date().toISOString(), archived_by: archivedBy })
      .eq("id", id)
      .is("archived_at", null),
    "archive community stake pool",
  );
}

export type StakePoolWalletMapping = {
  role: StakePoolWalletRole;
  address?: string;
  floatWalletId?: string;
  treasuryId?: string;
};

/** Replace every role mapping for a pool (admin confirmation step). */
export async function replaceStakePoolWallets(
  stakePoolId: string,
  mappings: readonly StakePoolWalletMapping[],
): Promise<StakePoolWalletRow[]> {
  check(
    await serviceClient().from("stake_pool_wallets").delete().eq("stake_pool_id", stakePoolId),
    "clear stake pool wallets",
  );
  if (mappings.length === 0) return [];
  const insert = mappings.map((m) => ({
    stake_pool_id: stakePoolId,
    role: m.role,
    address: m.address ?? null,
    float_wallet_id: m.floatWalletId ?? null,
    treasury_id: m.treasuryId ?? null,
  }));
  return rows<StakePoolWalletRow>(
    await serviceClient().from("stake_pool_wallets").insert(insert).select(STAKE_POOL_WALLET_COLUMNS),
    "replace stake pool wallets",
  );
}

/** Active pools of a community with reward addresses for withdraw matching. */
export async function loadPoolsForRewardMatch(communityId: string): Promise<
  {
    id: string;
    funding_source_id: string;
    reward_address: string | null;
    rewardAddresses: string[];
    treasuryIds: string[];
  }[]
> {
  const pools = await loadActiveCommunityStakePools(communityId);
  if (pools.length === 0) return [];
  const wallets = rows<StakePoolWalletRow>(
    await serviceClient()
      .from("stake_pool_wallets")
      .select(STAKE_POOL_WALLET_COLUMNS)
      .in(
        "stake_pool_id",
        pools.map((p) => p.id),
      ),
    "load stake pool wallets for match",
  );
  return pools.map((p) => {
    const mine = wallets.filter((w) => w.stake_pool_id === p.id);
    const rewardAddresses = [
      ...(p.reward_address ? [p.reward_address] : []),
      ...mine.filter((w) => w.role === "reward_account" && w.address).map((w) => w.address!),
    ];
    return {
      id: p.id,
      funding_source_id: p.funding_source_id,
      reward_address: p.reward_address,
      rewardAddresses: [...new Set(rewardAddresses)],
      treasuryIds: mine
        .filter((w) => w.role === "community_treasury" && w.treasury_id)
        .map((w) => w.treasury_id!),
    };
  });
}
