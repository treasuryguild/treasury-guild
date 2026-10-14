// A community's outside funders, what they committed and what has arrived:
// planned vs received per source and commitment, as the Funding page shows
// it (src/lib/funding/plan.ts). Received counts the inflows an admin tied to
// a source on the Incoming page.
import "server-only";

import { z } from "zod";
import type { V1FundingFigures, V1FundingResponse } from "@/lib/api/types";
import { ADA_ASSET, LOVELACE, tokenFallbackLabel } from "@/lib/assets";
import { loadAssetRegistry } from "@/lib/db/assets";
import { loadFundingOverview } from "@/lib/db/funding";
import { listCommunityTreasuries } from "@/lib/db/treasuries";
import { describeCommitment } from "@/lib/funding/display";
import { sourceSummary, type FundingInflow, type TokenFigures } from "@/lib/funding/plan";
import { routes } from "@/lib/routes";
import { defineEndpoint } from "./endpoint";
import { displayQuantity } from "./shape";
import { appLink, communityInput, memberCommunity } from "./shared";

/** Periods shown per commitment, the latest ones. */
const PERIODS_SHOWN = 12;

export const fundingSummary = defineEndpoint({
  scope: "communities:read",
  input: z.object({ community: communityInput }),
  async run(caller, input): Promise<V1FundingResponse> {
    const { community } = await memberCommunity(caller, input.community);
    const treasuries = await listCommunityTreasuries(community.id);
    const [overview, registry] = await Promise.all([
      loadFundingOverview(community.id, treasuries.map((t) => t.id)),
      loadAssetRegistry(community.id),
    ]);

    // Labels and decimals: a commitment's own amounts name their tokens; the
    // registry names the rest; an unknown unit is shown in base units.
    const tokens = new Map<string, { label: string; decimals: number }>([[LOVELACE, { label: ADA_ASSET.fieldName, decimals: ADA_ASSET.decimals }]]);
    for (const asset of registry) tokens.set(asset.unit, { label: asset.fieldName, decimals: asset.decimals });
    for (const amount of [...overview.commitments.flatMap((c) => c.amounts), ...overview.periods.flatMap((p) => p.amounts)]) {
      if (amount.asset_label) tokens.set(amount.unit, { label: amount.asset_label, decimals: amount.decimals });
    }
    const token = (unit: string) => tokens.get(unit) ?? { label: tokenFallbackLabel(unit), decimals: 0 };
    const show = (unit: string, quantity: string | null) => (quantity === null ? null : displayQuantity(quantity, token(unit).decimals));
    const figures = (list: readonly TokenFigures[]): V1FundingFigures[] => list.map((t) => ({
      token: token(t.unit).label,
      planned: show(t.unit, t.planned),
      due: show(t.unit, t.due)!,
      received: show(t.unit, t.received)!,
      difference: show(t.unit, t.difference)!,
      remaining: show(t.unit, t.remaining),
    }));
    const amounts = (sums: Record<string, string>) =>
      Object.fromEntries(Object.entries(sums).map(([unit, quantity]) => [token(unit).label, show(unit, quantity)!]));

    const inflows: FundingInflow[] = overview.inflows.map((i) => ({
      txHash: i.tx_hash,
      blockTime: i.block_time,
      sourceId: i.funding_source_id!,
      commitmentId: i.funding_commitment_id,
      amountLovelace: i.amount_lovelace,
      assets: i.assets,
    }));
    const now = new Date();

    return {
      community: { slug: community.slug, name: community.name },
      sources: overview.sources.map((source) => {
        const summary = sourceSummary(source.id, overview.commitments, overview.periods, inflows, now);
        const commitments = overview.commitments.filter((c) => c.source_id === source.id);
        return {
          name: source.name,
          description: source.description,
          url: source.url,
          totals: figures(summary.tokens),
          commitments: summary.commitments.map((s) => {
            const c = commitments.find((row) => row.id === s.id)!;
            return {
              name: c.name,
              kind: c.kind,
              plan: describeCommitment(c, overview.periods),
              note: c.note,
              figures: figures(s.tokens),
              periods: s.periods.slice(-PERIODS_SHOWN).map((p) => ({
                period: p.label,
                planned: amounts(p.planned),
                received: amounts(p.received),
                runningDifference: amounts(p.runningDifference),
              })),
            };
          }),
          unassigned: amounts(summary.unassigned),
        };
      }),
      url: appLink(routes.funding(community.slug)),
    };
  },
});
