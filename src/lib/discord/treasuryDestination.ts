// Connect / list helpers for a treasury's Discord payout destination
// (migration 0072): bot channel on the community's connected server, or a
// pasted webhook URL (handled by the route). Channel mode is text /
// announcement only.
import "server-only";

import {
  saveTreasuryDiscordChannel,
  type TreasuryDiscordDestination,
} from "@/lib/db/treasuries";
import type { TreasuryDiscordChannelType } from "@/lib/db/types";
import {
  DiscordBotError,
  listTextLikeChannels,
  postChannelMessage,
  type BotFetchLike,
} from "./bot";
import { loadDiscordGuild } from "./governanceChannel";
import { buildConnectedEmbed } from "./payoutMessage";

/** Text and announcement channels only — payouts are one-shot embeds. */
const PAYOUT_CHANNEL_TYPES = new Set([0, 5]);

export async function listTreasuryDiscordChannelOptions(
  communityId: string,
  options: { fetchImpl?: BotFetchLike } = {},
): Promise<{ id: string; name: string; type: number }[]> {
  const guild = await loadDiscordGuild(communityId);
  if (!guild) return [];
  const channels = await listTextLikeChannels(guild.guildId, options.fetchImpl);
  if (!channels) return [];
  return channels.filter((c) => PAYOUT_CHANNEL_TYPES.has(c.type));
}

/**
 * Verify the channel, post a hello message, store the destination and stamp
 * confirmed txs so connecting never announces history.
 */
export async function connectTreasuryDiscordChannel(
  treasury: { id: string; community_id: string; name: string },
  channelId: string,
  actor: string,
  options: { fetchImpl?: BotFetchLike } = {},
): Promise<{ destination: TreasuryDiscordDestination; now: string }> {
  const guild = await loadDiscordGuild(treasury.community_id);
  if (!guild) {
    throw new DiscordBotError("Connect a Discord server under Integrations first", null, true);
  }
  const channels = await listTextLikeChannels(guild.guildId, options.fetchImpl);
  if (!channels) {
    throw new DiscordBotError(
      "Treasury Guild bot is not in the Discord server — reconnect it under Integrations",
      null,
      true,
    );
  }
  const chosen = channels.find((c) => c.id === channelId && PAYOUT_CHANNEL_TYPES.has(c.type));
  if (!chosen) {
    throw new DiscordBotError(
      "That channel is not on the connected Discord server (or the bot cannot see it)",
      null,
      true,
    );
  }
  const channelType = chosen.type as TreasuryDiscordChannelType;
  await postChannelMessage(
    channelId,
    { embeds: buildConnectedEmbed(treasury.name).embeds },
    options.fetchImpl,
  );
  const now = new Date().toISOString();
  await saveTreasuryDiscordChannel({
    treasuryId: treasury.id,
    channelId,
    channelType,
    actor,
    now,
  });
  return {
    now,
    destination: {
      treasury_id: treasury.id,
      url: null,
      channel_id: channelId,
      channel_type: channelType,
      last_posted_at: now,
      last_error: null,
    },
  };
}
