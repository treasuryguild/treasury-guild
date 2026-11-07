// Link a Cardano stake pool to a community (migration 0099).
import { parseJson, sessionRoute } from "@/lib/api/route";
import { createCommunityStakePoolSchema } from "@/lib/api/schemas";
import type { CommunityStakePoolCreatedResponse } from "@/lib/api/types";
import { requireAdmin } from "@/lib/authz";
import { fetchPoolInfo } from "@/lib/cardano/koios";
import { asNetwork } from "@/lib/config";
import { requireCommunity } from "@/lib/db/communities";
import { enforceRateLimit } from "@/lib/db/rateLimit";
import { createCommunityStakePool } from "@/lib/db/stakePools";
import { loadTreasuryWithSigners } from "@/lib/db/treasuries";
import { BadRequestError } from "@/lib/errors";

export const POST = sessionRoute(async (req, { session }) => {
  const { communityId, poolId, treasuryId } = await parseJson(req, createCommunityStakePoolSchema);
  await requireAdmin(communityId, session.wallet);
  await enforceRateLimit("stakePoolCreate", session.wallet);

  const community = await requireCommunity(communityId);
  let network = asNetwork(community.network);
  if (treasuryId) {
    const { treasury } = await loadTreasuryWithSigners(treasuryId);
    if (treasury.community_id !== communityId) {
      throw new BadRequestError("That treasury is not in this community");
    }
    network = asNetwork(treasury.network);
  }

  const detail = await fetchPoolInfo(network, poolId);
  if (!detail) throw new BadRequestError("Stake pool not found on this network");

  const pool = await createCommunityStakePool({
    community_id: communityId,
    detail,
    created_by: session.wallet,
  });
  return {
    id: pool.id,
    fundingSourceId: pool.funding_source_id,
  } satisfies CommunityStakePoolCreatedResponse;
});
