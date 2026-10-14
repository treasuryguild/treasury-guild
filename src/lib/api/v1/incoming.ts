// What arrived in a community's treasuries, newest first: outside income,
// refunds and transfers between its own treasuries.
import "server-only";

import { z } from "zod";
import type { V1IncomingResponse } from "@/lib/api/types";
import { ADA_ASSET, tokenFallbackLabel } from "@/lib/assets";
import { loadAssetRegistry } from "@/lib/db/assets";
import { loadRecentIncoming } from "@/lib/db/dashboard";
import { routes } from "@/lib/routes";
import { defineEndpoint } from "./endpoint";
import { displayQuantity } from "./shape";
import { appLink, communityInput, memberCommunity } from "./shared";

export const INCOMING_LIST_MAX = 100;

export const listIncoming = defineEndpoint({
  scope: "communities:read",
  input: z.object({
    community: communityInput,
    limit: z.coerce.number().int().min(1).max(INCOMING_LIST_MAX).default(20)
      .describe("Newest inflows first, at most this many"),
  }),
  async run(caller, input): Promise<V1IncomingResponse> {
    const { community } = await memberCommunity(caller, input.community);
    const [incoming, registry] = await Promise.all([
      loadRecentIncoming(community.id, input.limit),
      loadAssetRegistry(community.id),
    ]);
    const known = new Map(registry.map((asset) => [asset.unit, asset]));
    // An unknown unit is shown in base units rather than guessed decimals.
    const tokens = (assets: Record<string, string> | null) => Object.fromEntries(
      Object.entries(assets ?? {}).map(([unit, quantity]) => {
        const asset = known.get(unit);
        return asset
          ? [asset.fieldName, displayQuantity(quantity, asset.decimals)]
          : [tokenFallbackLabel(unit), displayQuantity(quantity, 0)];
      }),
    );

    return {
      community: { slug: community.slug, name: community.name },
      incoming: incoming.map((item) => ({
        txHash: item.txHash,
        treasury: item.treasuryName,
        fromTreasury: item.fromTreasuryName,
        ada: displayQuantity(item.amountLovelace, ADA_ASSET.decimals),
        tokens: tokens(item.assets),
        blockTime: item.blockTime,
        type: item.incomingType,
        needsReview: item.requiresReconciliation && !item.matched,
      })),
      url: appLink(routes.reconcile(community.slug)),
    };
  },
});
