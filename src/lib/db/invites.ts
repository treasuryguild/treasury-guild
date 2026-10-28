// Community invite links: create / list / revoke for admins, preview and
// redeem for anyone with the token. Rows are service-role only.
import "server-only";

import { addressToNetwork } from "@/lib/cardano/multisigSDK";
import { BadRequestError, NotFoundError } from "@/lib/errors";
import {
  MAX_ACTIVE_INVITES_PER_COMMUNITY,
  inviteExpiresAt,
  type InviteExpiryDays,
} from "@/lib/invites/options";
import { generateInviteToken, hashInviteToken } from "@/lib/invites/token";
import { check, maybe, rows, rpc, serviceClient } from "./client";
import {
  COMMUNITY_INVITE_COLUMNS,
  COMMUNITY_INVITE_SUMMARY_COLUMNS,
  type CommunityInviteRow,
  type CommunityInviteSummary,
} from "./types";

export type { CommunityInviteSummary };

export interface CreateInviteInput {
  communityId: string;
  createdBy: string;
  expiresInDays: InviteExpiryDays | null;
  maxUses: number | null;
  label: string | null;
}

export interface CreatedInvite {
  invite: CommunityInviteSummary;
  /** Raw token, shown once so the admin can copy the URL. */
  token: string;
}

function withoutHash(row: CommunityInviteRow): CommunityInviteSummary {
  const { token_hash: _, ...rest } = row;
  return rest;
}

/** Active = not revoked (expired ones stay listed until purged). */
export async function countActiveInvites(communityId: string): Promise<number> {
  const listed = rows<{ id: string }>(
    await serviceClient()
      .from("community_invites")
      .select("id")
      .eq("community_id", communityId)
      .is("revoked_at", null),
    "count active invites",
  );
  return listed.length;
}

export async function createInvite(input: CreateInviteInput): Promise<CreatedInvite> {
  if ((await countActiveInvites(input.communityId)) >= MAX_ACTIVE_INVITES_PER_COMMUNITY) {
    throw new BadRequestError(
      `This community already has ${MAX_ACTIVE_INVITES_PER_COMMUNITY} active invite links. Revoke one first.`,
    );
  }

  const token = generateInviteToken();
  const row = maybe<CommunityInviteRow>(
    await serviceClient()
      .from("community_invites")
      .insert({
        community_id: input.communityId,
        token_hash: hashInviteToken(token),
        created_by: input.createdBy,
        expires_at: inviteExpiresAt(input.expiresInDays),
        max_uses: input.maxUses,
        label: input.label,
      })
      .select(COMMUNITY_INVITE_COLUMNS)
      .maybeSingle(),
    "create invite",
  );
  if (!row) throw new Error("create invite: no row");
  return { invite: withoutHash(row), token };
}

export async function listInvites(communityId: string): Promise<CommunityInviteSummary[]> {
  return rows<CommunityInviteSummary>(
    await serviceClient()
      .from("community_invites")
      .select(COMMUNITY_INVITE_SUMMARY_COLUMNS)
      .eq("community_id", communityId)
      .order("created_at", { ascending: false }),
    "list invites",
  );
}

export async function revokeInvite(inviteId: string, communityId: string): Promise<void> {
  const updated = rows<{ id: string }>(
    await serviceClient()
      .from("community_invites")
      .update({ revoked_at: new Date().toISOString() })
      .eq("id", inviteId)
      .eq("community_id", communityId)
      .is("revoked_at", null)
      .select("id"),
    "revoke invite",
  );
  if (updated.length === 0) throw new NotFoundError("Invite not found");
}

export interface InvitePreview {
  name: string;
  slug: string;
  network: number;
  /** False when the invite is revoked, expired or exhausted. */
  valid: boolean;
}

/**
 * What the invite page shows before joining. Invalid tokens look the same
 * (valid: false) so guessing does not distinguish missing from revoked.
 */
export async function previewInvite(token: string): Promise<InvitePreview | null> {
  const invite = maybe<CommunityInviteRow & {
    communities: { name: string; slug: string; network: number } | { name: string; slug: string; network: number }[] | null;
  }>(
    await serviceClient()
      .from("community_invites")
      .select(`${COMMUNITY_INVITE_COLUMNS}, communities!inner(name, slug, network)`)
      .eq("token_hash", hashInviteToken(token))
      .maybeSingle(),
    "preview invite",
  );
  if (!invite) return null;
  const community = Array.isArray(invite.communities) ? invite.communities[0]! : invite.communities!;
  const now = Date.now();
  const expired = invite.expires_at !== null && Date.parse(invite.expires_at) <= now;
  // Exhausted invites stay "valid" for preview so an existing member can still
  // open the link; the redeem RPC refuses new wallets once the cap is hit.
  const valid = invite.revoked_at === null && !expired;
  return {
    name: community.name,
    slug: community.slug,
    network: community.network,
    valid,
  };
}

export interface RedeemInviteResult {
  communityId: string;
  slug: string;
  name: string;
  network: number;
  already: boolean;
}

/** Join the wallet via the invite; network must match the community. */
export async function redeemInvite(token: string, wallet: string): Promise<RedeemInviteResult> {
  // Peek the community first so a wrong-network wallet never burns a use.
  const preview = await previewInvite(token);
  if (!preview?.valid) throw new NotFoundError("Invite not found");
  if (addressToNetwork(wallet) !== preview.network) {
    throw new BadRequestError(
      preview.network === 1
        ? "This community runs on mainnet: use a mainnet address"
        : "This community runs on preprod: use a preprod (addr_test…) address",
    );
  }

  return rpc<RedeemInviteResult>(
    await serviceClient().rpc("redeem_community_invite", {
      p_token_hash: hashInviteToken(token),
      p_wallet: wallet,
    }),
  );
}

/** Expired / revoked invites past the retention window (reconcile sweep). */
export async function purgeCommunityInvites(now: Date): Promise<number> {
  const res = await serviceClient().rpc("purge_community_invites", {
    p_now: now.toISOString(),
  });
  check(res, "purge community invites");
  return (res.data as number | null) ?? 0;
}
