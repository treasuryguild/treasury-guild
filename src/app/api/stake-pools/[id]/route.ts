// Refresh, remap wallets, or archive a community stake pool.
import { parseJson, sessionRoute } from "@/lib/api/route";
import { patchCommunityStakePoolSchema } from "@/lib/api/schemas";
import type { OkResponse } from "@/lib/api/types";
import { requireAdmin } from "@/lib/authz";
import { fetchPoolInfo } from "@/lib/cardano/koios";
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
    const detail = await fetchPoolInfo(asNetwork(community.network), pool.pool_id);
    if (!detail) throw new BadRequestError("Stake pool not found on this network");
    await refreshCommunityStakePool(pool.id, detail);
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
