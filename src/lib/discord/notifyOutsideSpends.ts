// Announce spends built outside the app (migration 0059): run by the
// reconcile sweep after the treasuries were synced, so the chain import has
// had its look at every new external_txs row. A row is posted once to the
// community's governance webhook and stamped; a community whose budget kind
// is off, or that has no webhook, gets the row stamped without a post (an
// alert is never posted late, as with proposal milestones). A transient
// webhook failure leaves the row for the next run.
import "server-only";

import { unitDisplayFromRegistry } from "@/lib/assetRegistry";
import { explorerTxUrl, asNetwork } from "@/lib/config";
import { ProposalKind } from "@/lib/constants";
import { loadAssetRegistry } from "@/lib/db/assets";
import { check, rows, serviceClient } from "@/lib/db/client";
import { loadGovernanceSettings } from "@/lib/db/governance";
import { listUnalertedSpends, markSpendAlerted } from "@/lib/db/outsideSpends";
import { errorMessage } from "@/lib/errors";
import { buildOutsideSpendEmbed } from "./outsideSpendMessage";
import { DiscordWebhookError, postDiscordWebhook, type FetchLike } from "./webhook";

export interface OutsideSpendNotifyResult {
  posted: number;
  /** Stamped without a post: budget kind off, no webhook, or a dead webhook. */
  skipped: number;
  failed: number;
}

export async function notifyOutsideSpends(options: { fetchImpl?: FetchLike } = {}): Promise<OutsideSpendNotifyResult> {
  const result: OutsideSpendNotifyResult = { posted: 0, skipped: 0, failed: 0 };
  const spends = await listUnalertedSpends();
  if (spends.length === 0) return result;
  const db = serviceClient();
  const communityIds = [...new Set(spends.map((s) => s.treasuries.community_id))];
  const [webhooks, communities] = await Promise.all([
    rows<{ community_id: string; url: string }>(
      await db.from("governance_discord_webhooks").select("community_id, url").in("community_id", communityIds),
      "load governance webhooks",
    ),
    rows<{ id: string; name: string }>(
      await db.from("communities").select("id, name").in("id", communityIds),
      "load communities",
    ),
  ]);
  const webhookByCommunity = new Map(webhooks.map((w) => [w.community_id, w.url]));
  const nameByCommunity = new Map(communities.map((c) => [c.id, c.name]));
  const budgetKindOn = new Map<string, boolean>();
  const displays = new Map<string, ReturnType<typeof unitDisplayFromRegistry>>();

  for (const spend of spends) {
    const communityId = spend.treasuries.community_id;
    if (!budgetKindOn.has(communityId)) {
      budgetKindOn.set(communityId, (await loadGovernanceSettings(communityId, ProposalKind.Budget)).enabled);
    }
    const url = webhookByCommunity.get(communityId);
    if (!budgetKindOn.get(communityId) || !url) {
      await markSpendAlerted([spend.tx_hash]);
      result.skipped += 1;
      continue;
    }
    if (!displays.has(communityId)) displays.set(communityId, unitDisplayFromRegistry(await loadAssetRegistry(communityId)));
    const network = asNetwork(spend.treasuries.network);
    const payload = buildOutsideSpendEmbed({
      communityName: nameByCommunity.get(communityId) ?? "the community",
      treasuryName: spend.treasuries.name,
      spend: {
        txHash: spend.tx_hash, blockTime: spend.block_time, amountLovelace: spend.amount_lovelace, assets: spend.assets,
        outputs: spend.to_addresses.length, toSiblingTreasury: spend.to_treasury_id !== null,
      },
      display: displays.get(communityId)!,
      explorerUrl: explorerTxUrl(network, spend.tx_hash),
    });
    try {
      await postDiscordWebhook(url, payload, options.fetchImpl);
    } catch (err) {
      console.error(`outside-spend alert for ${spend.tx_hash} failed`, err);
      if (!(err instanceof DiscordWebhookError && err.permanent)) {
        result.failed += 1;
        continue;
      }
      check(
        await db.from("governance_discord_webhooks").update({ last_error: errorMessage(err) }).eq("community_id", communityId),
        "record webhook error",
      );
      await markSpendAlerted([spend.tx_hash]);
      result.skipped += 1;
      continue;
    }
    await markSpendAlerted([spend.tx_hash]);
    check(
      await db.from("governance_discord_webhooks").update({ last_posted_at: new Date().toISOString(), last_error: null })
        .eq("community_id", communityId),
      "record webhook post",
    );
    result.posted += 1;
  }
  return result;
}
