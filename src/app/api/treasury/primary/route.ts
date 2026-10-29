import { parseJson, sessionRoute } from "@/lib/api/route";
import { setPrimaryTreasurySchema } from "@/lib/api/schemas";
import type { OkResponse } from "@/lib/api/types";
import { requireAdmin } from "@/lib/authz";
import { Role } from "@/lib/constants";
import { requireCommunity, setPrimaryTreasury } from "@/lib/db/communities";
import { addMember, promoteMembersToAdmin } from "@/lib/db/membership";
import {
  isPrimaryTreasuryBaseSigner,
  loadBaseSignerWallets,
  loadTreasury,
} from "@/lib/db/treasuries";
import { BadRequestError, ForbiddenError } from "@/lib/errors";

/**
 * Point the community at a primary treasury. Its base signers become
 * community admins; former primary signers are not auto-demoted. Only a
 * current primary base signer may re-point (a non-signer admin could
 * otherwise strip the protected admins by switching primary first).
 */
export const POST = sessionRoute(async (req, { session }) => {
  const { communityId, treasuryId } = await parseJson(req, setPrimaryTreasurySchema);
  await requireAdmin(communityId, session.wallet);
  const community = await requireCommunity(communityId);
  const treasury = await loadTreasury(treasuryId);
  if (treasury.community_id !== communityId) {
    throw new BadRequestError("Choose a treasury of this community");
  }
  if (community.primary_treasury_id === treasuryId) {
    return { ok: true } satisfies OkResponse;
  }
  if (!(await isPrimaryTreasuryBaseSigner(communityId, session.wallet))) {
    throw new ForbiddenError("Only a primary treasury signer can change the primary treasury");
  }

  await setPrimaryTreasury(communityId, treasuryId);

  const signerWallets = await loadBaseSignerWallets(treasuryId);
  for (const wallet of signerWallets) {
    await addMember(communityId, wallet, Role.Admin);
  }
  await promoteMembersToAdmin(communityId, signerWallets);

  return { ok: true } satisfies OkResponse;
});
