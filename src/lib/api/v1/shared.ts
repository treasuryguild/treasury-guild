// Checks and inputs shared by the community-scoped agent API endpoints.
import "server-only";

import { z } from "zod";
import type { ApiCaller } from "@/lib/api/caller";
import { memberRole } from "@/lib/authz";
import { Visibility } from "@/lib/constants";
import { requireCommunityBySlug } from "@/lib/db/communities";
import { contributorLabel } from "@/lib/assignees";
import { optionalRelation } from "@/lib/db/client";
import { listCommunityMembers } from "@/lib/db/membership";
import { listCommunityTreasuries, type TreasuryWithSigners } from "@/lib/db/treasuries";
import type { CommunityRow } from "@/lib/db/types";
import { listCommunityWorkgroups, type CommunityWorkgroup } from "@/lib/db/workgroups";
import { appUrl } from "@/lib/env.server";
import { BadRequestError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { matchMembers, type MemberRef } from "./shape";

export const communityInput = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .describe("Community slug, as community_list returns it");

/**
 * The community the caller is a member of. A private community's slug says
 * nothing to a non-member (404, as if it did not exist); a public one answers
 * 403, since its existence is no secret.
 */
export async function memberCommunity(
  caller: ApiCaller,
  slug: string,
): Promise<{ community: CommunityRow; role: string }> {
  const community = await requireCommunityBySlug(slug);
  const role = await memberRole(community.id, caller.wallet);
  if (!role) {
    if (community.visibility === Visibility.Private) throw new NotFoundError("Community not found");
    throw new ForbiddenError("Not a community member");
  }
  return { community, role };
}

/**
 * The community's workgroup named (case-insensitively) or identified by
 * `nameOrId`; 400 naming the workgroups there are, so a model can correct itself.
 */
export async function resolveCommunityWorkgroup(communityId: string, nameOrId: string): Promise<CommunityWorkgroup> {
  const workgroups = await listCommunityWorkgroups(communityId);
  const wanted = nameOrId.toLowerCase();
  const match = workgroups.find((w) => w.id === nameOrId || w.name.toLowerCase() === wanted);
  if (!match) {
    throw new BadRequestError(
      `No workgroup "${nameOrId}" in this community. Workgroups: ${workgroups.map((w) => w.name).join(", ") || "none"}`,
    );
  }
  return match;
}

/** The community's treasury named (case-insensitively) or identified by `nameOrId`; 400 naming them otherwise. */
export async function resolveCommunityTreasury(communityId: string, nameOrId: string): Promise<TreasuryWithSigners> {
  const treasuries = await listCommunityTreasuries(communityId);
  const wanted = nameOrId.toLowerCase();
  const match = treasuries.find((t) => t.id === nameOrId || t.name.toLowerCase() === wanted);
  if (!match) {
    throw new BadRequestError(
      `No treasury "${nameOrId}" in this community. Treasuries: ${treasuries.map((t) => t.name).join(", ") || "none"}`,
    );
  }
  return match;
}

/** The community's members as the agent API names and matches them. */
export async function communityMemberRefs(communityId: string): Promise<(MemberRef & { role: string })[]> {
  return (await listCommunityMembers(communityId)).map((m) => {
    const profile = optionalRelation(m.contributors);
    return {
      wallet: m.wallet_address,
      role: m.role,
      handle: profile?.handle ?? null,
      githubUsername: profile?.github_username ?? null,
    };
  });
}

/** The one member `query` names (wallet, handle or GitHub login); 400 when none or several do. */
export function requireMember<M extends MemberRef>(query: string, members: readonly M[]): M {
  const matches = matchMembers(query, members);
  if (matches.length === 1) return matches[0]!;
  if (matches.length === 0) {
    throw new BadRequestError(`No member "${query}" in this community. member_list shows who is.`);
  }
  throw new BadRequestError(
    `"${query}" matches ${matches.length} members: ${matches.map((m) => `${memberName(m)} (${m.wallet})`).join(", ")}. Use one of their wallets.`,
  );
}

/** How the app names a member: handle, GitHub login, else the short wallet. */
export function memberName(m: MemberRef): string {
  return contributorLabel({ wallet: m.wallet, handle: m.handle, githubUsername: m.githubUsername });
}

/** An absolute link into the app, for a model to hand to the user. */
export function appLink(path: string): string {
  return `${appUrl().replace(/\/+$/, "")}${path}`;
}
