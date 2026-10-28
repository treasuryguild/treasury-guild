// Announce spends built outside the app (migration 0059 / 0071): run by the
// reconcile sweep after the treasuries were synced. A row is posted once to
// the community's governance Discord channel and stamped; a community whose
// budget kind is off, or that has no channel, gets the row stamped without a
// post. A transient bot failure leaves the row for the next run.
import "server-only";

import { unitDisplayFromRegistry } from "@/lib/assetRegistry";
import { explorerTxUrl, asNetwork } from "@/lib/config";
import { ProposalKind } from "@/lib/constants";
import { loadAssetRegistry } from "@/lib/db/assets";
import { rows, serviceClient } from "@/lib/db/client";
import { loadGovernanceSettings } from "@/lib/db/governance";
import { listUnalertedSpends, markSpendAlerted } from "@/lib/db/outsideSpends";
import { errorMessage } from "@/lib/errors";
import { DiscordBotError, postChannelMessage, type BotFetchLike } from "./bot";
import {
  listGovernanceChannelsFor, recordGovernanceChannelError, recordGovernanceChannelPost,
} from "./governanceChannel";
import { buildOutsideSpendEmbed } from "./outsideSpendMessage";

export interface OutsideSpendNotifyResult {
  posted: number;
  /** Stamped without a post: budget kind off, no channel, or a dead channel. */
  skipped: number;
  failed: number;
}

export async function notifyOutsideSpends(options: { fetchImpl?: BotFetchLike } = {}): Promise<OutsideSpendNotifyResult> {
  const result: OutsideSpendNotifyResult = { posted: 0, skipped: 0, failed: 0 };
  const spends = await listUnalertedSpends();
  if (spends.length === 0) return result;
  const communityIds = [...new Set(spends.map((s) => s.treasuries.community_id))];
  const [channels, communities] = await Promise.all([
    listGovernanceChannelsFor(communityIds),
    rows<{ id: string; name: string }>(
      await serviceClient().from("communities").select("id, name").in("id", communityIds),
      "load communities",
    ),
  ]);
  const channelByCommunity = new Map(channels.map((c) => [c.community_id, c]));
  const nameByCommunity = new Map(communities.map((c) => [c.id, c.name]));
  const budgetKindOn = new Map<string, boolean>();
  const displays = new Map<string, ReturnType<typeof unitDisplayFromRegistry>>();

  for (const spend of spends) {
    const communityId = spend.treasuries.community_id;
    if (!budgetKindOn.has(communityId)) {
      budgetKindOn.set(communityId, (await loadGovernanceSettings(communityId, ProposalKind.Budget)).enabled);
    }
    const channel = channelByCommunity.get(communityId);
    if (!budgetKindOn.get(communityId) || !channel) {
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
      await postChannelMessage(channel.channel_id, { embeds: payload.embeds }, options.fetchImpl);
    } catch (err) {
      console.error(`outside-spend alert for ${spend.tx_hash} failed`, err);
      if (!(err instanceof DiscordBotError && err.permanent)) {
        result.failed += 1;
        continue;
      }
      await recordGovernanceChannelError(communityId, errorMessage(err));
      await markSpendAlerted([spend.tx_hash]);
      result.skipped += 1;
      continue;
    }
    await markSpendAlerted([spend.tx_hash]);
    await recordGovernanceChannelPost(communityId);
    result.posted += 1;
  }
  return result;
}
