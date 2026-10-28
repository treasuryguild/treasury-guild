// The community's governance Discord channel (migration 0071): one channel
// on the Discord server from call_integrations. Service-role only.
import "server-only";

import { IntegrationProvider } from "@/lib/constants";
import { loadIntegration } from "@/lib/db/callCapture";
import { check, maybe, rows, serviceClient } from "@/lib/db/client";
import {
  GOVERNANCE_DISCORD_CHANNEL_COLUMNS,
  type GovernanceDiscordChannelRow,
  type GovernanceDiscordChannelType,
} from "@/lib/db/types";

export type GovernanceChannelRow = GovernanceDiscordChannelRow;

export async function loadGovernanceChannel(communityId: string): Promise<GovernanceChannelRow | null> {
  return maybe<GovernanceChannelRow>(
    await serviceClient().from("governance_discord_channels")
      .select(GOVERNANCE_DISCORD_CHANNEL_COLUMNS)
      .eq("community_id", communityId)
      .maybeSingle(),
    "load governance discord channel",
  );
}

export async function listGovernanceChannels(): Promise<GovernanceChannelRow[]> {
  return rows<GovernanceChannelRow>(
    await serviceClient().from("governance_discord_channels").select(GOVERNANCE_DISCORD_CHANNEL_COLUMNS),
    "list governance discord channels",
  );
}

export async function listGovernanceChannelsFor(
  communityIds: string[],
): Promise<GovernanceChannelRow[]> {
  if (communityIds.length === 0) return [];
  return rows<GovernanceChannelRow>(
    await serviceClient().from("governance_discord_channels")
      .select(GOVERNANCE_DISCORD_CHANNEL_COLUMNS)
      .in("community_id", communityIds),
    "list governance discord channels for communities",
  );
}

export async function upsertGovernanceChannel(input: {
  communityId: string;
  channelId: string;
  channelType: GovernanceDiscordChannelType;
  actor: string;
}): Promise<GovernanceChannelRow> {
  const now = new Date().toISOString();
  const row = {
    community_id: input.communityId,
    channel_id: input.channelId,
    channel_type: input.channelType,
    created_by: input.actor,
    created_at: now,
    last_posted_at: now,
    last_error: null,
  };
  check(
    await serviceClient().from("governance_discord_channels").upsert(row),
    "save governance discord channel",
  );
  return row;
}

export async function removeGovernanceChannel(communityId: string): Promise<void> {
  check(
    await serviceClient().from("governance_discord_channels").delete().eq("community_id", communityId),
    "remove governance discord channel",
  );
}

export async function recordGovernanceChannelPost(communityId: string): Promise<void> {
  check(
    await serviceClient().from("governance_discord_channels").update({
      last_posted_at: new Date().toISOString(),
      last_error: null,
    }).eq("community_id", communityId),
    "record governance discord post",
  );
}

export async function recordGovernanceChannelError(communityId: string, error: string): Promise<void> {
  check(
    await serviceClient().from("governance_discord_channels")
      .update({ last_error: error })
      .eq("community_id", communityId),
    "record governance discord error",
  );
}

/** Discord server id + label for a community, or null when not connected. */
export async function loadDiscordGuild(
  communityId: string,
): Promise<{ guildId: string; label: string | null } | null> {
  const integration = await loadIntegration(communityId, IntegrationProvider.Discord);
  if (!integration) return null;
  return { guildId: integration.external_account_id, label: integration.label };
}
