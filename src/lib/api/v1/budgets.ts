// Budget against spending for a period, per workgroup and treasury, as the
// Budgets page shows it, trimmed for a model to read.
import "server-only";

import { z } from "zod";
import type { V1BudgetsResponse } from "@/lib/api/types";
import { ADA_ASSET, LOVELACE, tokenFallbackLabel } from "@/lib/assets";
import { currentBudgetMonth, monthDate } from "@/lib/budgets";
import { loadAssetRegistry } from "@/lib/db/assets";
import { loadBudgetDashboard } from "@/lib/db/budgetDashboard";
import { routes } from "@/lib/routes";
import { defineEndpoint } from "./endpoint";
import { displayQuantity } from "./shape";
import { appLink, communityInput, memberCommunity } from "./shared";

export const RECENT_SPENDING_MAX = 20;

interface TokenDisplay {
  label: string;
  decimals: number;
}

export const budgetSummary = defineEndpoint({
  scope: "communities:read",
  input: z.object({
    community: communityInput,
    month: z.string().regex(/^[1-9]\d{3}-(0[1-9]|1[0-2])$/, "month must be YYYY-MM").optional()
      .describe("Budget month, YYYY-MM; the current month when omitted"),
    view: z.enum(["month", "quarter", "recurring"]).default("month")
      .describe("month: that month (and a quarterly budget's quarter); quarter: the whole quarter; recurring: the recurring plan"),
  }),
  async run(caller, input): Promise<V1BudgetsResponse> {
    const { community } = await memberCommunity(caller, input.community);
    const month = input.month ?? currentBudgetMonth();
    const [dashboard, registry] = await Promise.all([
      loadBudgetDashboard(community.id, monthDate(month), input.view),
      loadAssetRegistry(community.id),
    ]);

    // Budgets carry their token's label and decimals; spending and totals only a unit.
    const tokens = new Map<string, TokenDisplay>([[LOVELACE, { label: ADA_ASSET.fieldName, decimals: ADA_ASSET.decimals }]]);
    for (const asset of registry) tokens.set(asset.unit, { label: asset.fieldName, decimals: asset.decimals });
    for (const budget of dashboard.budgets) tokens.set(budget.unit, { label: budget.assetLabel, decimals: budget.decimals });
    // An unknown unit is shown in base units rather than guessed decimals.
    const token = (unit: string): TokenDisplay => tokens.get(unit) ?? { label: tokenFallbackLabel(unit), decimals: 0 };
    const amount = (unit: string, quantity: string) => displayQuantity(quantity, token(unit).decimals);

    return {
      community: { slug: community.slug, name: community.name },
      view: input.view,
      month,
      budgets: dashboard.budgets.map((b) => ({
        owner: b.ownerName,
        ownerType: b.ownerType,
        cadence: b.cadence,
        period: b.periodLabel,
        token: b.assetLabel,
        budget: displayQuantity(b.amount, b.decimals),
        spent: displayQuantity(b.spent, b.decimals),
        remaining: displayQuantity(b.balance, b.decimals),
      })),
      totals: dashboard.totals.map((t) => ({
        token: token(t.unit).label,
        budget: amount(t.unit, t.amount),
        spent: amount(t.unit, t.spent),
        remaining: amount(t.unit, t.balance),
      })),
      recentSpending: dashboard.spending.slice(0, RECENT_SPENDING_MAX).map((s) => ({
        owner: s.ownerName,
        kind: s.kind,
        title: s.title,
        token: token(s.unit).label,
        amount: amount(s.unit, s.amount),
        status: s.status,
        createdAt: s.createdAt,
      })),
      url: appLink(routes.budgets(community.slug, { month, view: input.view })),
    };
  },
});
