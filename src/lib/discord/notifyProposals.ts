// Announce proposals on a community's governance Discord channel (migration
// 0071): run by the reconcile sweep after proposals were moved along. Each
// proposal's due milestone is posted once (into its discussion thread when
// one exists) and recorded in proposals.discord_milestone. A transient
// failure is retried next run; a permanent one is recorded on the channel
// and the milestone skipped.
import "server-only";

import type { GovernanceDiscordStatus } from "@/lib/api/types";
import { check, maybe, rows, serviceClient } from "@/lib/db/client";
import { PROPOSAL_COLUMNS, type ProposalRow } from "@/lib/db/types";
import { appUrl } from "@/lib/env.server";
import { errorMessage } from "@/lib/errors";
import { routes } from "@/lib/routes";
import type { GovernanceDiscordChannelType } from "@/lib/db/types";
import { DiscordBotError, listTextLikeChannels, postChannelMessage, type BotFetchLike } from "./bot";
import {
  loadDiscordGuild, loadGovernanceChannel, listGovernanceChannels,
  recordGovernanceChannelError, recordGovernanceChannelPost,
  removeGovernanceChannel, upsertGovernanceChannel,
} from "./governanceChannel";
import { stampCurrentAnchorAlerts } from "./notifyAnchorsDue";
import {
  buildGovernanceConnectedEmbed, buildProposalEmbed, currentMilestone, dueMilestone, type ProposalMilestone,
} from "./proposalMessage";
import { ensureProposalDiscordThread } from "./proposalThreads";

const BATCH = 100;

export interface ProposalNotifyResult {
  posted: number;
  failed: number;
  dead: number;
}

export async function notifyProposalMilestones(
  now: Date,
  options: { fetchImpl?: BotFetchLike } = {},
): Promise<ProposalNotifyResult> {
  const result: ProposalNotifyResult = { posted: 0, failed: 0, dead: 0 };
  const db = serviceClient();
  const channels = await listGovernanceChannels();
  if (channels.length === 0) return result;
  const byCommunity = new Map(channels.map((c) => [c.community_id, c]));
  const communities = new Map(rows<{ id: string; name: string; slug: string }>(
    await db.from("communities").select("id, name, slug").in("id", [...byCommunity.keys()]),
    "load communities",
  ).map((c) => [c.id, c]));
  const proposals = rows<ProposalRow>(
    await db.from("proposals").select(PROPOSAL_COLUMNS)
      .in("community_id", [...byCommunity.keys()])
      .or("discord_milestone.is.null,discord_milestone.neq.closed")
      .order("created_at")
      .limit(BATCH),
    "load proposals to announce",
  );

  const stamp = async (id: string, milestone: ProposalMilestone) => check(
    await db.from("proposals").update({ discord_milestone: milestone }).eq("id", id),
    "stamp proposal announcement",
  );
  for (const proposal of proposals) {
    const milestone = dueMilestone(proposal, now.getTime());
    const channel = byCommunity.get(proposal.community_id);
    const community = communities.get(proposal.community_id);
    if (!milestone || !channel || !community) continue;

    if (proposal.rules.discussionHours > 0 && !proposal.discord_thread_id) {
      const ensured = await ensureProposalDiscordThread(proposal.id, options);
      if (ensured.status === "failed" && !ensured.permanent) {
        result.failed += 1;
        continue;
      }
      if (ensured.status === "created" || ensured.status === "exists") {
        const refreshed = maybe<Pick<ProposalRow, "discord_thread_id">>(
          await db.from("proposals").select("discord_thread_id").eq("id", proposal.id).maybeSingle(),
          "reload proposal thread",
        );
        proposal.discord_thread_id = refreshed?.discord_thread_id ?? null;
      }
    }

    const payload = buildProposalEmbed({
      communityName: community.name,
      proposal,
      milestone,
      url: `${appUrl()}${routes.proposal(community.slug, proposal.id)}`,
    });
    const targetChannelId = proposal.discord_thread_id ?? channel.channel_id;
    try {
      await postChannelMessage(targetChannelId, { embeds: payload.embeds }, options.fetchImpl);
    } catch (err) {
      console.error(`discord announcement of proposal ${proposal.id} failed`, err);
      if (!(err instanceof DiscordBotError && err.permanent)) {
        result.failed += 1;
        continue;
      }
      await recordGovernanceChannelError(proposal.community_id, errorMessage(err));
      await stamp(proposal.id, milestone);
      result.dead += 1;
      continue;
    }
    await stamp(proposal.id, milestone);
    await recordGovernanceChannelPost(proposal.community_id);
    result.posted += 1;
  }
  return result;
}

export async function loadGovernanceDiscordStatus(communityId: string): Promise<GovernanceDiscordStatus> {
  const guild = await loadDiscordGuild(communityId);
  const channel = await loadGovernanceChannel(communityId);
  return {
    serverConnected: !!guild,
    serverLabel: guild?.label ?? null,
    channelId: channel?.channel_id ?? null,
    channelType: channel?.channel_type ?? null,
    lastPostedAt: channel?.last_posted_at ?? null,
    lastError: channel?.last_error ?? null,
  };
}

/**
 * Verify the channel, post a hello message, store it, and treat every
 * proposal's current milestone as announced: connecting never posts history.
 */
export async function connectGovernanceDiscordChannel(
  community: { id: string; name: string },
  channelId: string,
  actor: string,
  options: { fetchImpl?: BotFetchLike } = {},
): Promise<GovernanceDiscordStatus> {
  const guild = await loadDiscordGuild(community.id);
  if (!guild) {
    throw new DiscordBotError("Connect a Discord server under Call capture first", null, true);
  }
  const channels = await listTextLikeChannels(guild.guildId, options.fetchImpl);
  if (!channels) {
    throw new DiscordBotError("Treasury Guild bot is not in the Discord server — reconnect it under Call capture", null, true);
  }
  const chosen = channels.find((c) => c.id === channelId);
  if (!chosen) {
    throw new DiscordBotError("That channel is not on the connected Discord server (or the bot cannot see it)", null, true);
  }
  const channelType = chosen.type as GovernanceDiscordChannelType;
  await postChannelMessage(
    channelId,
    { embeds: buildGovernanceConnectedEmbed(community.name).embeds },
    options.fetchImpl,
  );
  const now = new Date();
  await upsertGovernanceChannel({
    communityId: community.id,
    channelId,
    channelType,
    actor,
  });
  const db = serviceClient();
  const proposals = rows<Pick<ProposalRow, "id" | "state" | "closes_at" | "execution_state" | "rules">>(
    await db.from("proposals").select("id, state, closes_at, execution_state, rules").eq("community_id", community.id),
    "load proposals",
  );
  const byMilestone = new Map<ProposalMilestone, string[]>();
  for (const p of proposals) {
    const milestone = currentMilestone(p, now.getTime());
    byMilestone.set(milestone, [...(byMilestone.get(milestone) ?? []), p.id]);
  }
  for (const [milestone, ids] of byMilestone) {
    check(await db.from("proposals").update({ discord_milestone: milestone }).in("id", ids), "stamp announced proposals");
  }
  await stampCurrentAnchorAlerts(community.id, now);
  return loadGovernanceDiscordStatus(community.id);
}

export async function removeGovernanceDiscordChannel(communityId: string): Promise<void> {
  await removeGovernanceChannel(communityId);
}

/** Channels the admin may pick for governance posts. */
export async function listGovernanceDiscordChannelOptions(
  communityId: string,
  options: { fetchImpl?: BotFetchLike } = {},
): Promise<{ id: string; name: string; type: number }[]> {
  const guild = await loadDiscordGuild(communityId);
  if (!guild) return [];
  const channels = await listTextLikeChannels(guild.guildId, options.fetchImpl);
  return channels ?? [];
}
