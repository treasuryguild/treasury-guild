import { parseJson, sessionRoute } from "@/lib/api/route";
import {
  memberAddSchema,
  memberDeleteSchema,
  memberPatchSchema,
} from "@/lib/api/schemas";
import type { OkResponse } from "@/lib/api/types";
import { memberRole, requireAdmin } from "@/lib/authz";
import { Role } from "@/lib/constants";
import { addMember, removeMember, setMemberRole } from "@/lib/db/membership";
import { isCommunityTreasurySigner, isPrimaryTreasuryBaseSigner } from "@/lib/db/treasuries";
import { BadRequestError, NotFoundError } from "@/lib/errors";

// Admin management of community_members. Reads happen client-side via RLS;
// this route is writes-only.

/** The target must exist, not be the caller (`selfMessage`), and not be the owner. */
async function guardTarget(
  communityId: string,
  targetWallet: string,
  sessionWallet: string,
  selfMessage: string,
): Promise<void> {
  if (targetWallet === sessionWallet) {
    throw new BadRequestError(selfMessage);
  }
  const role = await memberRole(communityId, targetWallet);
  if (!role) throw new NotFoundError("Member not found");
  if (role === Role.Owner) {
    throw new BadRequestError("The owner's role cannot be changed");
  }
}

export const POST = sessionRoute(async (req, { session }) => {
  const { communityId, wallet: target } = await parseJson(req, memberAddSchema);
  await requireAdmin(communityId, session.wallet);
  await addMember(communityId, target);
  return { ok: true } satisfies OkResponse;
});

export const PATCH = sessionRoute(async (req, { session }) => {
  const { communityId, wallet: target, role } = await parseJson(
    req,
    memberPatchSchema,
  );
  await requireAdmin(communityId, session.wallet);
  await guardTarget(communityId, target, session.wallet, "You cannot change your own role");

  // Primary treasury base signers are admins by construction; signers of
  // other treasuries, recovery signers and co-signers may be demoted.
  if (role === Role.Member && (await isPrimaryTreasuryBaseSigner(communityId, target))) {
    throw new BadRequestError("Primary treasury signers must remain admins");
  }

  await setMemberRole(communityId, target, role);
  return { ok: true } satisfies OkResponse;
});

export const DELETE = sessionRoute(async (req, { session }) => {
  const { communityId, wallet: target } = await parseJson(
    req,
    memberDeleteSchema,
  );
  await requireAdmin(communityId, session.wallet);
  await guardTarget(communityId, target, session.wallet, "You cannot remove yourself");

  // Every group: removing a recovery signer or co-signer would silently
  // disable that part of the script.
  if (await isCommunityTreasurySigner(communityId, target)) {
    throw new BadRequestError("Treasury signers cannot be removed");
  }

  await removeMember(communityId, target);
  return { ok: true } satisfies OkResponse;
});
