// Membership writes (community_members has no client write policies). All
// upserts use ignoreDuplicates so an existing owner/admin row is never
// downgraded and repeated calls are idempotent.
import "server-only";

import { Role } from "@/lib/constants";
import { check, relation, rows, serviceClient } from "./client";
import { MEMBER_WITH_CONTRIBUTOR_COLUMNS, type CommunityRow, type MemberWithContributor } from "./types";
import { communityWorkgroupIds, workgroupCommunityId } from "./workgroups";

/**
 * Ensure a contributor row exists. `created` is true only on a real insert
 * (ON CONFLICT DO NOTHING returns no rows otherwise), which doubles as a
 * race-free first-login signal.
 */
export async function ensureContributor(
  wallet: string,
): Promise<{ created: boolean }> {
  const inserted = rows<{ wallet_address: string }>(
    await serviceClient()
      .from("contributors")
      .upsert(
        { wallet_address: wallet },
        { onConflict: "wallet_address", ignoreDuplicates: true },
      )
      .select("wallet_address"),
    "ensure contributor",
  );
  return { created: inserted.length > 0 };
}

/** Ensure the wallet is at least `role` in the community (never downgrades). */
export async function ensureMember(
  communityId: string,
  wallet: string,
  role: Role = Role.Member,
): Promise<void> {
  check(
    await serviceClient()
      .from("community_members")
      .upsert(
        { community_id: communityId, wallet_address: wallet, role },
        { onConflict: "community_id,wallet_address", ignoreDuplicates: true },
      ),
    "ensure member",
  );
}

/** Ensure a contributor row exists and the wallet is at least a 'member'. */
export async function addMember(
  communityId: string,
  wallet: string,
  role: Role = Role.Member,
): Promise<void> {
  await ensureContributor(wallet);
  await ensureMember(communityId, wallet, role);
}

/** addMember for a workgroup's community. No-op when the workgroup is gone. */
export async function addWorkgroupMember(
  workgroupId: string,
  wallet: string,
): Promise<void> {
  const communityId = await workgroupCommunityId(workgroupId);
  if (communityId) await addMember(communityId, wallet);
}

/** Promote plain members to admin (owners and existing admins untouched). */
export async function promoteMembersToAdmin(
  communityId: string,
  wallets: string[],
): Promise<void> {
  if (wallets.length === 0) return;
  check(
    await serviceClient()
      .from("community_members")
      .update({ role: Role.Admin })
      .eq("community_id", communityId)
      .eq("role", Role.Member)
      .in("wallet_address", wallets),
    "promote members",
  );
}

/**
 * Join the wallet to every community that has a task assigned to this GitHub
 * login (task_assignees.gh_login -> tasks -> workgroups -> community). Called
 * when a user links GitHub; the hourly sync covers assignments made after that.
 * Note: membership grants community-wide read (treasuries, members, boards) —
 * that is the intended access model for GitHub-driven communities.
 * GitHub logins are [A-Za-z0-9-], so ilike needs no wildcard escaping.
 */
export async function autoJoinCommunitiesForGithubLogin(
  wallet: string,
  login: string,
): Promise<string[]> {
  const assignees = rows<{
    tasks: { workgroups: { community_id: string } | null } | null;
  }>(
    await serviceClient()
      .from("task_assignees")
      .select("tasks!inner(workgroups!inner(community_id))")
      .ilike("gh_login", login),
    "load tasks by assignee",
  );
  const communityIds = [
    ...new Set(
      assignees
        .map((a) => a.tasks?.workgroups?.community_id)
        .filter((id): id is string => !!id),
    ),
  ];
  for (const communityId of communityIds) {
    await addMember(communityId, wallet);
  }
  return communityIds;
}

export type MemberCommunity = Pick<CommunityRow, "id" | "slug" | "name" | "description" | "network" | "visibility">;

/** Every community the wallet belongs to, with its role there, by name. */
export async function communitiesForWallet(
  wallet: string,
): Promise<{ role: string; community: MemberCommunity }[]> {
  const memberships = rows<{ role: string; communities: MemberCommunity | MemberCommunity[] }>(
    await serviceClient()
      .from("community_members")
      .select("role, communities!inner(id, slug, name, description, network, visibility)")
      .eq("wallet_address", wallet),
    "load wallet communities",
  );
  return memberships
    .map((m) => ({ role: m.role, community: relation(m.communities) }))
    .sort((a, b) => a.community.name.localeCompare(b.community.name));
}

export async function setMemberRole(communityId: string, wallet: string, role: Role): Promise<void> {
  check(
    await serviceClient()
      .from("community_members")
      .update({ role })
      .eq("community_id", communityId)
      .eq("wallet_address", wallet),
    "update role",
  );
}

/** Drop the wallet's lead assignments in this community, then the membership itself. */
export async function removeMember(communityId: string, wallet: string): Promise<void> {
  const db = serviceClient();
  const wgIds = await communityWorkgroupIds(communityId);
  if (wgIds.length > 0) {
    check(
      await db
        .from("workgroup_leads")
        .delete()
        .eq("wallet_address", wallet)
        .in("workgroup_id", wgIds),
      "drop lead assignments",
    );
  }
  check(
    await db
      .from("community_members")
      .delete()
      .eq("community_id", communityId)
      .eq("wallet_address", wallet),
    "remove member",
  );
}

/** Every member wallet of the community. */
/** The community's members with their profiles, as members read them in the app (RLS members_read). */
export async function listCommunityMembers(communityId: string): Promise<MemberWithContributor[]> {
  return rows<MemberWithContributor>(
    await serviceClient()
      .from("community_members")
      .select(MEMBER_WITH_CONTRIBUTOR_COLUMNS)
      .eq("community_id", communityId)
      .order("created_at"),
    "list community members",
  );
}

export async function communityMemberWallets(communityId: string): Promise<string[]> {
  return rows<{ wallet_address: string }>(
    await serviceClient().from("community_members").select("wallet_address").eq("community_id", communityId),
    "load known signer addresses",
  ).map((m) => m.wallet_address);
}
