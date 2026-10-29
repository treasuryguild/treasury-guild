import "server-only";

import { PgCode, SignerGroup, TxState, type CosignerKind, type TreasuryTemplate } from "@/lib/constants";
import { ConflictError, InvariantError, NotFoundError } from "@/lib/errors";
import { check, maybe, rpc, rows, serviceClient } from "./client";
import type { TreasuryLifecycleStatus } from "@/lib/api/types";
import type {
  TreasuryDiscordChannelType,
  TreasuryDiscordDestinationRow,
  TreasuryRow,
  TreasurySignerRow,
} from "./types";

/** New payouts, mints and anchors from a treasury an admin has archived. */
export const ARCHIVED_TREASURY_BUILD = "Restore this treasury before building from it";

/** A payment from an archived treasury that is not entirely a transfer to another treasury. */
export const ARCHIVED_TREASURY_PAYMENT =
  "Restore this treasury before paying out. A transfer to another treasury is still allowed.";

/** Refuses a build from an archived treasury. Signing an in-flight transaction does not call this. */
export function assertTreasuryActive(
  treasury: { archived_at?: string | null },
  message = ARCHIVED_TREASURY_BUILD,
): void {
  if (treasury.archived_at) throw new ConflictError(message);
}

export async function loadTreasury(treasuryId: string): Promise<TreasuryRow> {
  const treasury = maybe<TreasuryRow>(
    await serviceClient()
      .from("treasuries")
      .select("*")
      .eq("id", treasuryId)
      .maybeSingle(),
    "load treasury",
  );
  if (!treasury) throw new NotFoundError("Treasury not found");
  return treasury;
}

export async function loadTreasurySigners(
  treasuryId: string,
): Promise<TreasurySignerRow[]> {
  return rows<TreasurySignerRow>(
    await serviceClient()
      .from("treasury_signers")
      .select("*")
      .eq("treasury_id", treasuryId),
    "load treasury signers",
  );
}

export async function loadTreasuryWithSigners(
  treasuryId: string,
): Promise<{ treasury: TreasuryRow; signers: TreasurySignerRow[] }> {
  const treasury = await loadTreasury(treasuryId);
  const signers = await loadTreasurySigners(treasuryId);
  return { treasury, signers };
}

/**
 * Whether the wallet is one of this treasury's base signers: the treasury
 * actors. Recovery signers and a co-signer are not (they only sign their own
 * path), so the browser's `signerTreasuryIds` and this check agree.
 */
export async function isTreasurySigner(treasuryId: string, wallet: string): Promise<boolean> {
  const hit = maybe<{ wallet_address: string }>(
    await serviceClient()
      .from("treasury_signers")
      .select("wallet_address")
      .eq("treasury_id", treasuryId)
      .eq("wallet_address", wallet)
      .eq("signer_group", SignerGroup.Base)
      .maybeSingle(),
    "check treasury signer",
  );
  return hit !== null;
}

export type CommunityTreasury = Pick<TreasuryRow, "id" | "community_id" | "address" | "network">;

/** Every treasury of the community, enough to read its wallet on its network. */
export async function loadCommunityTreasuries(communityId: string): Promise<CommunityTreasury[]> {
  return rows<CommunityTreasury>(
    await serviceClient()
      .from("treasuries")
      .select("id, community_id, address, network")
      .eq("community_id", communityId),
    "load community treasuries",
  );
}

export type WalletTreasury = Pick<TreasuryRow, "id" | "name" | "network"> & {
  communities: { name: string; slug: string };
};

/** Every treasury of the communities the wallet belongs to, by community then name (the /dev tools). */
export async function listTreasuriesForWallet(wallet: string): Promise<WalletTreasury[]> {
  const memberships = rows<{ community_id: string }>(
    await serviceClient().from("community_members").select("community_id").eq("wallet_address", wallet),
    "load memberships",
  );
  if (memberships.length === 0) return [];
  return rows<WalletTreasury>(
    await serviceClient()
      .from("treasuries")
      .select("id, name, network, communities!inner(name, slug)")
      .in("community_id", memberships.map((m) => m.community_id))
      .order("name"),
    "list wallet treasuries",
  );
}

/**
 * Whether the wallet signs for any of the community's treasuries, in any
 * group by default or only in the given ones (primary base signers are the
 * admins; recovery signers and co-signers are not).
 */
export async function isCommunityTreasurySigner(
  communityId: string,
  wallet: string,
  groups?: readonly SignerGroup[],
): Promise<boolean> {
  let query = serviceClient()
    .from("treasury_signers")
    .select("treasury_id, treasuries!inner(community_id)")
    .eq("wallet_address", wallet)
    .eq("treasuries.community_id", communityId);
  if (groups) query = query.in("signer_group", [...groups]);
  const hits = rows<{ treasury_id: string }>(await query.limit(1), "check treasury signer");
  return hits.length > 0;
}

/**
 * Whether the wallet is a base signer of the community's primary treasury
 * (the group that must remain community admins).
 */
export async function isPrimaryTreasuryBaseSigner(
  communityId: string,
  wallet: string,
): Promise<boolean> {
  const community = maybe<{ primary_treasury_id: string | null }>(
    await serviceClient()
      .from("communities")
      .select("primary_treasury_id")
      .eq("id", communityId)
      .maybeSingle(),
    "load primary treasury",
  );
  if (!community?.primary_treasury_id) return false;
  return isTreasurySigner(community.primary_treasury_id, wallet);
}

/** Base signer wallets of a treasury (for promoting primary signers to admin). */
export async function loadBaseSignerWallets(treasuryId: string): Promise<string[]> {
  return rows<{ wallet_address: string }>(
    await serviceClient()
      .from("treasury_signers")
      .select("wallet_address")
      .eq("treasury_id", treasuryId)
      .eq("signer_group", SignerGroup.Base),
    "load base signers",
  ).map((r) => r.wallet_address);
}

export async function countCommunityTreasuries(
  communityId: string,
): Promise<number> {
  const res = await serviceClient()
    .from("treasuries")
    .select("id", { count: "exact", head: true })
    .eq("community_id", communityId);
  check(res, "count treasuries");
  return res.count ?? 0;
}

export type TreasuryWithSigners = Pick<
  TreasuryRow,
  "id" | "name" | "address" | "network" | "required" | "script_type" | "template" | "lock_until" | "recovery_script_type" | "recovery_required" | "cosigner_kind" | "archived_at"
> & {
  treasury_signers: Pick<TreasurySignerRow, "wallet_address" | "display_name" | "signer_group">[];
};

/** The community's treasuries with their signers, by name. */
export async function listCommunityTreasuries(communityId: string): Promise<TreasuryWithSigners[]> {
  return rows<TreasuryWithSigners>(
    await serviceClient()
      .from("treasuries")
      .select("id, name, address, network, required, script_type, template, lock_until, recovery_script_type, recovery_required, cosigner_kind, archived_at, treasury_signers(wallet_address, display_name, signer_group)")
      .eq("community_id", communityId)
      .order("name"),
    "list community treasuries",
  );
}

/** Insert a treasury; null when its address already exists (unique violation). */
export async function insertTreasury(row: {
  community_id: string;
  name: string;
  network: number;
  required: number;
  script_type: string;
  address: string;
  script_cbor: string;
  stake_credential_hash?: string | null;
  template: TreasuryTemplate;
  lock_slot: number | null;
  lock_until: string | null;
  recovery_script_type: string | null;
  recovery_required: number | null;
  cosigner_kind: CosignerKind | null;
}): Promise<TreasuryRow | null> {
  const { data, error } = await serviceClient().from("treasuries").insert(row).select().single();
  if (error) {
    if (error.code === PgCode.UniqueViolation) return null;
    throw new InvariantError(`create treasury: ${error.message}`);
  }
  return data as TreasuryRow;
}

/** The treasury that already uses this address, if one does. */
export async function findTreasuryByAddress(
  address: string,
): Promise<Pick<TreasuryRow, "id" | "community_id" | "archived_at"> | null> {
  return maybe(
    await serviceClient()
      .from("treasuries")
      .select("id, community_id, archived_at")
      .eq("address", address)
      .maybeSingle(),
    "find treasury by address",
  );
}

/** What archiving this treasury would meet (treasury_lifecycle_status); null when it is gone. */
export async function loadTreasuryLifecycleStatus(treasuryId: string): Promise<TreasuryLifecycleStatus | null> {
  return rpc<TreasuryLifecycleStatus | null>(
    await serviceClient().rpc("treasury_lifecycle_status", { p_treasury_id: treasuryId }),
  );
}

/** Archive or restore a treasury; the rules live in change_treasury_lifecycle. */
export async function changeTreasuryLifecycle(input: {
  treasuryId: string;
  action: "archive" | "restore";
  actor: string;
}): Promise<void> {
  rpc(
    await serviceClient().rpc("change_treasury_lifecycle", {
      p_treasury_id: input.treasuryId, p_action: input.action, p_actor: input.actor,
    }),
  );
}

/** Compensating delete of a treasury row whose dependent writes failed (creation only). */
export async function deleteTreasury(treasuryId: string): Promise<void> {
  check(await serviceClient().from("treasuries").delete().eq("id", treasuryId), "delete treasury");
}

export async function insertTreasurySigners(
  treasuryId: string,
  signers: Pick<
    TreasurySignerRow,
    "wallet_address" | "key_hash" | "display_name" | "signer_group" | "stake_key_hash" | "drep_key_hash"
  >[],
): Promise<void> {
  check(
    await serviceClient()
      .from("treasury_signers")
      .insert(signers.map((s) => ({ ...s, treasury_id: treasuryId }))),
    "insert treasury signers",
  );
}

/**
 * Tag movements between the community's own treasuries (tag_internal_transfers).
 * Best effort: a failure is logged and the next poll tags them.
 */
export async function tagInternalTransfers(communityId: string): Promise<void> {
  const { error } = await serviceClient().rpc("tag_internal_transfers", { p_community_id: communityId });
  if (error) console.error(`tag_internal_transfers ${communityId} failed`, error);
}

/** A treasury's Discord destination (webhook URL or bot channel). Never send `url` to the browser. */
export type TreasuryDiscordDestination = Pick<
  TreasuryDiscordDestinationRow,
  "treasury_id" | "url" | "channel_id" | "channel_type" | "last_posted_at" | "last_error"
>;

export async function listTreasuryDiscordDestinations(
  communityId: string,
): Promise<TreasuryDiscordDestination[]> {
  return rows<TreasuryDiscordDestination>(
    await serviceClient()
      .from("treasury_discord_destinations")
      .select(
        "treasury_id, url, channel_id, channel_type, last_posted_at, last_error, treasuries!inner(community_id)",
      )
      .eq("treasuries.community_id", communityId),
    "load discord destinations",
  );
}

async function stampConfirmedForDiscord(treasuryId: string, now: string): Promise<void> {
  check(
    await serviceClient()
      .from("transactions")
      .update({ discord_notified_at: now })
      .eq("treasury_id", treasuryId)
      .eq("state", TxState.Confirmed)
      .is("discord_notified_at", null),
    "stamp confirmed transactions",
  );
}

/**
 * Store a webhook destination as posted at `now` and stamp the treasury's
 * confirmed transactions: connecting never announces history.
 */
export async function saveTreasuryDiscordWebhook(input: {
  treasuryId: string;
  url: string;
  actor: string;
  now: string;
}): Promise<void> {
  const db = serviceClient();
  check(
    await db.from("treasury_discord_destinations").upsert({
      treasury_id: input.treasuryId,
      url: input.url,
      channel_id: null,
      channel_type: null,
      created_by: input.actor,
      created_at: input.now,
      last_posted_at: input.now,
      last_error: null,
    }),
    "save discord webhook",
  );
  await stampConfirmedForDiscord(input.treasuryId, input.now);
}

/**
 * Store a bot-channel destination as posted at `now` and stamp confirmed
 * transactions the same way as the webhook path.
 */
export async function saveTreasuryDiscordChannel(input: {
  treasuryId: string;
  channelId: string;
  channelType: TreasuryDiscordChannelType;
  actor: string;
  now: string;
}): Promise<void> {
  const db = serviceClient();
  check(
    await db.from("treasury_discord_destinations").upsert({
      treasury_id: input.treasuryId,
      url: null,
      channel_id: input.channelId,
      channel_type: input.channelType,
      created_by: input.actor,
      created_at: input.now,
      last_posted_at: input.now,
      last_error: null,
    }),
    "save discord channel",
  );
  await stampConfirmedForDiscord(input.treasuryId, input.now);
}

export async function deleteTreasuryDiscordDestination(treasuryId: string): Promise<void> {
  check(
    await serviceClient().from("treasury_discord_destinations").delete().eq("treasury_id", treasuryId),
    "remove discord destination",
  );
}
