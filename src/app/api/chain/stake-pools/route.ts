// Stake pools for the Staking page picker and for resolving pool tickers on
// the Treasury activity list (Koios pool_list). Membership is enough: the
// catalog is public chain data and titles must resolve even when the first
// listed wallet is not an SDK treasury.
import { parseQuery, sessionRoute } from "@/lib/api/route";
import { stakePoolsQuerySchema } from "@/lib/api/schemas";
import type { StakePoolsResponse } from "@/lib/api/types";
import { lookupStakePool, searchStakePools } from "@/lib/cardano/koios";
import { requireMember } from "@/lib/authz";
import { asNetwork } from "@/lib/config";
import { enforceRateLimit } from "@/lib/db/rateLimit";
import { loadTreasuryWithSigners } from "@/lib/db/treasuries";

export const GET = sessionRoute(async (req, { session }) => {
  const { treasuryId, q, poolId, limit } = parseQuery(req, stakePoolsQuerySchema);
  await enforceRateLimit("chainProxy", session.wallet);
  const { treasury } = await loadTreasuryWithSigners(treasuryId);
  await requireMember(treasury.community_id, session.wallet);
  const network = asNetwork(treasury.network);
  if (poolId) {
    const pool = await lookupStakePool(network, poolId);
    return { pools: pool ? [pool] : [] } satisfies StakePoolsResponse;
  }
  const pools = await searchStakePools(network, { q, limit });
  return { pools } satisfies StakePoolsResponse;
});
