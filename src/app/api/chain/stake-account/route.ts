// Stake account status for an SDK treasury's reward address (Koios).
import { parseQuery, sessionRoute } from "@/lib/api/route";
import { treasuryIdOnlyQuerySchema } from "@/lib/api/schemas";
import type { StakeAccountResponse } from "@/lib/api/types";
import { fetchStakeAccountStatus } from "@/lib/cardano/koios";
import { requireSdkStake } from "@/lib/cardano/sdkTreasury";
import { requireMember } from "@/lib/authz";
import { loadTreasuryWithSigners } from "@/lib/db/treasuries";
import { asNetwork } from "@/lib/config";

export const GET = sessionRoute(async (req, { session }) => {
  const { treasuryId } = parseQuery(req, treasuryIdOnlyQuerySchema);
  const { treasury, signers } = await loadTreasuryWithSigners(treasuryId);
  await requireMember(treasury.community_id, session.wallet);
  const sdk = requireSdkStake(treasury, signers);
  const status = await fetchStakeAccountStatus(asNetwork(treasury.network), sdk.rewardAddress);
  return {
    rewardAddress: sdk.rewardAddress,
    active: status.active,
    poolId: status.poolId,
    dRepId: status.dRepId,
    rewardsAvailable: status.rewardsAvailable,
  } satisfies StakeAccountResponse;
});
