// Announce due on-chain anchors on a community's governance Discord webhook
// (migration 0070): run by the reconcile sweep after tally documents are
// frozen and published. Two kinds — stale due steps (≥3 days) and a
// copy-grace heads-up (last 6h before the closed step goes without a
// locator). Each (proposal, step, kind) posts once per due_since episode;
// connecting a webhook stamps current candidates without posting history.
import "server-only";

import { CLOSED_ANCHOR_COPY_GRACE_MS } from "@/lib/governance/anchors";
import {
  loadAnchorAlertCandidates, type AnchorAlertCandidate,
} from "@/lib/governance/anchorsDue";
import {
  loadAnchorAlertStamps, needsAnchorAlert, stampAnchorAlerts, type AnchorAlertStampKey,
} from "@/lib/db/anchorAlerts";
import { check, rows, serviceClient } from "@/lib/db/client";
import { appUrl } from "@/lib/env.server";
import { errorMessage } from "@/lib/errors";
import { routes } from "@/lib/routes";
import { buildCopyGraceEmbed, buildStaleAnchorsEmbed } from "./anchorMessage";
import { DiscordWebhookError, postDiscordWebhook, type FetchLike } from "./webhook";

const BATCH = 50;

export interface AnchorNotifyResult {
  posted: number;
  /** Stamped without a post: dead webhook. */
  skipped: number;
  failed: number;
}

interface WebhookRow {
  community_id: string;
  url: string;
}

/**
 * For each community with a governance webhook: load alert candidates, skip
 * those already stamped for the same due_since, post digests / grace embeds,
 * stamp. A transient webhook failure leaves candidates for the next run; a
 * permanent one stamps without posting.
 */
export async function notifyAnchorsDue(
  now: Date = new Date(),
  options: { fetchImpl?: FetchLike } = {},
): Promise<AnchorNotifyResult> {
  const result: AnchorNotifyResult = { posted: 0, skipped: 0, failed: 0 };
  const db = serviceClient();
  const webhooks = rows<WebhookRow>(
    await db.from("governance_discord_webhooks").select("community_id, url"),
    "load governance webhooks for anchors",
  );
  if (webhooks.length === 0) return result;

  const communities = new Map(rows<{ id: string; name: string; slug: string }>(
    await db.from("communities").select("id, name, slug").in("id", webhooks.map((w) => w.community_id)),
    "load communities for anchor alerts",
  ).map((c) => [c.id, c]));

  let remaining = BATCH;
  for (const webhook of webhooks) {
    if (remaining <= 0) break;
    const community = communities.get(webhook.community_id);
    if (!community) continue;

    let candidates: AnchorAlertCandidate[];
    try {
      candidates = await loadAnchorAlertCandidates(community.id, now.getTime());
    } catch (err) {
      console.error(`load anchor alerts of community ${community.id} failed`, err);
      result.failed += 1;
      continue;
    }
    if (candidates.length === 0) continue;

    const stamps = await loadAnchorAlertStamps(candidates.map((c) => c.proposalId));
    const fresh = candidates.filter((c) => needsAnchorAlert(stamps, {
      proposalId: c.proposalId, step: c.step, kind: c.kind, dueSince: c.dueSince,
    }));
    if (fresh.length === 0) continue;

    const toStamp = fresh.slice(0, remaining);
    remaining -= toStamp.length;

    const stale = toStamp.filter((c) => c.kind === "stale");
    const grace = toStamp.filter((c) => c.kind === "copy_grace");
    const keys = (items: readonly AnchorAlertCandidate[]): AnchorAlertStampKey[] =>
      items.map((c) => ({ proposalId: c.proposalId, step: c.step, kind: c.kind, dueSince: c.dueSince }));

    const postOrStamp = async (
      payload: ReturnType<typeof buildStaleAnchorsEmbed>,
      items: readonly AnchorAlertCandidate[],
    ): Promise<"posted" | "failed" | "skipped"> => {
      try {
        await postDiscordWebhook(webhook.url, payload, options.fetchImpl);
      } catch (err) {
        console.error(`anchor alert for community ${community.id} failed`, err);
        if (!(err instanceof DiscordWebhookError && err.permanent)) {
          return "failed";
        }
        check(
          await db.from("governance_discord_webhooks").update({ last_error: errorMessage(err) })
            .eq("community_id", community.id),
          "record webhook error",
        );
        await stampAnchorAlerts(keys(items));
        return "skipped";
      }
      await stampAnchorAlerts(keys(items));
      check(
        await db.from("governance_discord_webhooks")
          .update({ last_posted_at: new Date().toISOString(), last_error: null })
          .eq("community_id", community.id),
        "record webhook post",
      );
      return "posted";
    };

    if (stale.length > 0) {
      const outcome = await postOrStamp(buildStaleAnchorsEmbed({
        communityName: community.name,
        lines: stale.map((c) => ({ number: c.number, title: c.title, step: c.step })),
        proposalsUrl: `${appUrl()}${routes.proposals(community.slug)}`,
      }), stale);
      if (outcome === "posted") result.posted += 1;
      else if (outcome === "failed") result.failed += 1;
      else result.skipped += 1;
      // A transient failure on the digest: leave grace for next run too (same webhook).
      if (outcome === "failed") continue;
    }

    for (const item of grace) {
      const graceEndsAt = new Date(Date.parse(item.dueSince) + CLOSED_ANCHOR_COPY_GRACE_MS).toISOString();
      const outcome = await postOrStamp(buildCopyGraceEmbed({
        communityName: community.name,
        number: item.number,
        title: item.title,
        proposalUrl: `${appUrl()}${routes.proposal(community.slug, item.proposalId)}`,
        graceEndsAt,
      }), [item]);
      if (outcome === "posted") result.posted += 1;
      else if (outcome === "failed") {
        result.failed += 1;
        break;
      } else result.skipped += 1;
    }
  }
  return result;
}

/**
 * Stamp every current alert candidate for a community without posting
 * (webhook connect: never dump history).
 */
export async function stampCurrentAnchorAlerts(communityId: string, now: Date = new Date()): Promise<void> {
  const candidates = await loadAnchorAlertCandidates(communityId, now.getTime());
  await stampAnchorAlerts(candidates.map((c) => ({
    proposalId: c.proposalId, step: c.step, kind: c.kind, dueSince: c.dueSince,
  })));
}
