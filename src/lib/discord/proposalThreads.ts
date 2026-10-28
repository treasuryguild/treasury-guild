// Auto-create a Discord discussion thread/forum post for a proposal
// (migration 0071). Best-effort: never fails proposal create; the reconcile
// sweep retries via ensureProposalDiscordThread before milestones.
import "server-only";

import { check, maybe, serviceClient } from "@/lib/db/client";
import { PROPOSAL_COLUMNS, type ProposalRow } from "@/lib/db/types";
import { appUrl } from "@/lib/env.server";
import { errorMessage } from "@/lib/errors";
import { truncate } from "@/lib/format";
import { KIND_LABELS } from "@/lib/governance/labels";
import { routes } from "@/lib/routes";
import {
  createForumPost, DiscordBotError, postChannelMessage, startThreadFromMessage,
  type BotFetchLike,
} from "./bot";
import {
  loadDiscordGuild, loadGovernanceChannel, recordGovernanceChannelError,
} from "./governanceChannel";
import { USERNAME, type DiscordWebhookPayload } from "./payoutMessage";

const FORUM_TYPE = 15;
const COLORS = { neutral: 0x6366f1 } as const;

function threadName(p: Pick<ProposalRow, "number" | "title">): string {
  return truncate(`#${p.number} · ${p.title}`, 100);
}

function discussionUrl(guildId: string, threadId: string): string {
  return `https://discord.com/channels/${guildId}/${threadId}`;
}

function starterEmbed(input: {
  communityName: string;
  proposal: Pick<ProposalRow, "number" | "title" | "kind">;
  url: string;
}): DiscordWebhookPayload {
  const heading = `Proposal #${input.proposal.number} · ${KIND_LABELS[input.proposal.kind]}`;
  return {
    username: USERNAME,
    embeds: [{
      title: truncate(`💬 Discussion · ${heading}`, 256),
      url: input.url,
      description: `**${truncate(input.proposal.title, 300)}**\n${input.communityName} · discuss here, vote with your wallet in Treasury Guild`,
      color: COLORS.neutral,
    }],
  };
}

export type EnsureThreadResult =
  | { status: "created" | "exists" | "skipped" }
  | { status: "failed"; permanent: boolean; error: string };

/**
 * Ensure a discussion thread exists for the proposal when Governance Discord
 * is configured and the proposal has a discussion period. Idempotent.
 */
export async function ensureProposalDiscordThread(
  proposalId: string,
  options: { fetchImpl?: BotFetchLike } = {},
): Promise<EnsureThreadResult> {
  const proposal = maybe<ProposalRow>(
    await serviceClient().from("proposals").select(PROPOSAL_COLUMNS).eq("id", proposalId).maybeSingle(),
    "load proposal for discord thread",
  );
  if (!proposal) return { status: "skipped" };
  if (proposal.discord_thread_id) return { status: "exists" };
  if (proposal.rules.discussionHours <= 0) return { status: "skipped" };

  const channel = await loadGovernanceChannel(proposal.community_id);
  if (!channel) return { status: "skipped" };
  const guild = await loadDiscordGuild(proposal.community_id);
  if (!guild) return { status: "skipped" };

  const community = maybe<{ name: string; slug: string }>(
    await serviceClient().from("communities").select("name, slug").eq("id", proposal.community_id).maybeSingle(),
    "load community for discord thread",
  );
  if (!community) return { status: "skipped" };

  const url = `${appUrl()}${routes.proposal(community.slug, proposal.id)}`;
  const embed = starterEmbed({
    communityName: community.name,
    proposal,
    url,
  });
  const name = threadName(proposal);

  try {
    let threadId: string;
    if (channel.channel_type === FORUM_TYPE) {
      const thread = await createForumPost(channel.channel_id, {
        name,
        embeds: embed.embeds,
      }, options.fetchImpl);
      threadId = thread.id;
    } else {
      const message = await postChannelMessage(channel.channel_id, {
        embeds: embed.embeds,
      }, options.fetchImpl);
      const thread = await startThreadFromMessage(
        channel.channel_id, message.id, name, options.fetchImpl,
      );
      threadId = thread.id;
    }
    check(
      await serviceClient().from("proposals").update({
        discord_thread_id: threadId,
        discord_discussion_url: discussionUrl(guild.guildId, threadId),
      }).eq("id", proposal.id).is("discord_thread_id", null),
      "stamp proposal discord thread",
    );
    return { status: "created" };
  } catch (err) {
    const permanent = err instanceof DiscordBotError && err.permanent;
    const message = errorMessage(err);
    console.error(`discord thread for proposal ${proposal.id} failed`, err);
    if (permanent) {
      await recordGovernanceChannelError(proposal.community_id, message);
    }
    return { status: "failed", permanent, error: message };
  }
}

/** Fire-and-forget after create: never throws into the create path. */
export async function tryEnsureProposalDiscordThread(proposalId: string): Promise<void> {
  try {
    await ensureProposalDiscordThread(proposalId);
  } catch (err) {
    console.error(`discord thread ensure for proposal ${proposalId} failed`, err);
  }
}
