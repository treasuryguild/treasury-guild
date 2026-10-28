// Announce proposals on a community's Discord webhook (migration 0057): run
// by the reconcile sweep after proposals were moved along. Each proposal's
// due milestone is posted once and recorded in proposals.discord_milestone. A
// transient failure (429, 5xx, network) is retried next run; a permanent one
// (deleted webhook) is recorded on the webhook and the milestone skipped.
import "server-only";

import type { DiscordWebhookStatus } from "@/lib/api/types";
import { check, maybe, rows, serviceClient } from "@/lib/db/client";
import { PROPOSAL_COLUMNS, type ProposalRow } from "@/lib/db/types";
import { appUrl } from "@/lib/env.server";
import { errorMessage } from "@/lib/errors";
import { routes } from "@/lib/routes";
import { stampCurrentAnchorAlerts } from "./notifyAnchorsDue";
import {
  buildGovernanceConnectedEmbed, buildProposalEmbed, currentMilestone, dueMilestone, type ProposalMilestone,
} from "./proposalMessage";
import { DiscordWebhookError, postDiscordWebhook, webhookUrlHint, type FetchLike } from "./webhook";

const BATCH = 100;

export interface ProposalNotifyResult {
  posted: number;
  failed: number;
  dead: number;
}

interface WebhookRow {
  community_id: string;
  url: string;
  last_posted_at: string | null;
  last_error: string | null;
}

export async function notifyProposalMilestones(
  now: Date,
  options: { fetchImpl?: FetchLike } = {},
): Promise<ProposalNotifyResult> {
  const result: ProposalNotifyResult = { posted: 0, failed: 0, dead: 0 };
  const db = serviceClient();
  const webhooks = rows<WebhookRow>(
    await db.from("governance_discord_webhooks").select("community_id, url, last_posted_at, last_error"),
    "load governance webhooks",
  );
  if (webhooks.length === 0) return result;
  const byCommunity = new Map(webhooks.map((w) => [w.community_id, w]));
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
    const webhook = byCommunity.get(proposal.community_id);
    const community = communities.get(proposal.community_id);
    if (!milestone || !webhook || !community) continue;
    const payload = buildProposalEmbed({
      communityName: community.name,
      proposal,
      milestone,
      url: `${appUrl()}${routes.proposal(community.slug, proposal.id)}`,
    });
    try {
      await postDiscordWebhook(webhook.url, payload, options.fetchImpl);
    } catch (err) {
      console.error(`discord announcement of proposal ${proposal.id} failed`, err);
      if (!(err instanceof DiscordWebhookError && err.permanent)) {
        result.failed += 1;
        continue;
      }
      check(
        await db.from("governance_discord_webhooks").update({ last_error: errorMessage(err) }).eq("community_id", proposal.community_id),
        "record webhook error",
      );
      await stamp(proposal.id, milestone);
      result.dead += 1;
      continue;
    }
    await stamp(proposal.id, milestone);
    check(
      await db.from("governance_discord_webhooks").update({ last_posted_at: new Date().toISOString(), last_error: null })
        .eq("community_id", proposal.community_id),
      "record webhook post",
    );
    result.posted += 1;
  }
  return result;
}

export async function loadGovernanceWebhook(communityId: string): Promise<DiscordWebhookStatus | null> {
  const row = maybe<WebhookRow>(
    await serviceClient().from("governance_discord_webhooks").select("community_id, url, last_posted_at, last_error")
      .eq("community_id", communityId).maybeSingle(),
    "load governance webhook",
  );
  return row ? { urlHint: webhookUrlHint(row.url), lastPostedAt: row.last_posted_at, lastError: row.last_error } : null;
}

/**
 * Test the URL with a hello message, store it, and treat every proposal's
 * current milestone as announced: connecting never posts history.
 */
export async function connectGovernanceWebhook(
  community: { id: string; name: string },
  url: string,
  actor: string,
  options: { fetchImpl?: FetchLike } = {},
): Promise<DiscordWebhookStatus> {
  await postDiscordWebhook(url, buildGovernanceConnectedEmbed(community.name), options.fetchImpl);
  const db = serviceClient();
  const now = new Date();
  check(
    await db.from("governance_discord_webhooks").upsert({
      community_id: community.id, url, created_by: actor, created_at: now.toISOString(),
      last_posted_at: now.toISOString(), last_error: null,
    }),
    "save governance webhook",
  );
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
  // Anchor reminders: stamp whatever is already due or in the copy-grace
  // window so connecting never dumps history into the channel.
  await stampCurrentAnchorAlerts(community.id, now);
  return { urlHint: webhookUrlHint(url), lastPostedAt: now.toISOString(), lastError: null };
}

export async function removeGovernanceWebhook(communityId: string): Promise<void> {
  check(
    await serviceClient().from("governance_discord_webhooks").delete().eq("community_id", communityId),
    "remove governance webhook",
  );
}
