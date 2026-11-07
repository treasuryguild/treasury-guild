// Refresh, remap wallets, or archive a community stake pool.
import { parseJson, sessionRoute } from "@/lib/api/route";
import { patchCommunityStakePoolSchema } from "@/lib/api/schemas";
import type { OkResponse } from "@/lib/api/types";
import { requireAdmin } from "@/lib/authz";
import { fetchPoolInfo } from "@/lib/cardano/koios";
import { resolvePoolIconUrl } from "@/lib/cardano/poolIcon";
import { asNetwork } from "@/lib/config";
import { requireCommunity } from "@/lib/db/communities";
import {
  archiveCommunityStakePool,
  refreshCommunityStakePool,
  replaceStakePoolWallets,
  requireCommunityStakePool,
} from "@/lib/db/stakePools";
import { BadRequestError } from "@/lib/errors";

export const PATCH = sessionRoute<{ id: string }>(async (req, { params, session }) => {
  const body = await parseJson(req, patchCommunityStakePoolSchema);
  const pool = await requireCommunityStakePool(params.id);
  await requireAdmin(pool.community_id, session.wallet);

  if (body.archive) {
    await archiveCommunityStakePool(pool.id, session.wallet);
    return { ok: true } satisfies OkResponse;
  }

  if (body.refresh) {
    const community = await requireCommunity(pool.community_id);
    const network = asNetwork(community.network);
    const detail = await fetchPoolInfo(network, pool.pool_id);
    if (!detail) throw new BadRequestError("Stake pool not found on this network");
    const iconUrl = await resolvePoolIconUrl(network, detail.poolId);
    await refreshCommunityStakePool(pool.id, detail, iconUrl);
  }

  if (body.wallets) {
    await replaceStakePoolWallets(
      pool.id,
      body.wallets.map((w) => ({
        role: w.role,
        address: w.address,
        floatWalletId: w.floatWalletId,
        treasuryId: w.treasuryId,
      })),
    );
  }

  return { ok: true } satisfies OkResponse;
});
