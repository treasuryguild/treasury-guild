// How funding sources read on the page: the tokens an admin can plan in, the
// ticker and decimals of every unit on screen, and a commitment's one-line
// description. Pure and client-safe.
import { ADA_ASSET, tokenFallbackLabel, type AssetDef } from "@/lib/assets";
import { periodLabel } from "@/lib/budgets";
import type { FundingCommitmentRow, FundingPeriodRow } from "@/lib/db/types";
import { formatUnits } from "@/lib/format";

export interface FundingTokenOption {
  unit: string;
  ticker: string;
  decimals: number;
}

/**
 * Tokens to plan in: ADA, the community's registry, the treasuries' tokens
 * and every token a commitment already uses, each unit once (first wins).
 */
export function fundingTokenOptions(
  registry: readonly AssetDef[],
  walletTokens: readonly { unit: string; ticker: string | null; decimals: number }[],
  commitments: readonly FundingCommitmentRow[],
  periods: readonly FundingPeriodRow[],
): FundingTokenOption[] {
  const out = new Map<string, FundingTokenOption>();
  const add = (unit: string, ticker: string | null, decimals: number) => {
    if (!out.has(unit)) out.set(unit, { unit, ticker: ticker || tokenFallbackLabel(unit), decimals });
  };
  add(ADA_ASSET.unit, ADA_ASSET.fieldName, ADA_ASSET.decimals);
  for (const asset of registry) add(asset.unit, asset.fieldName, asset.decimals);
  for (const token of walletTokens) add(token.unit, token.ticker, token.decimals);
  for (const amounts of [...commitments.map((c) => c.amounts), ...periods.map((p) => p.amounts)]) {
    for (const a of amounts) add(a.unit, a.asset_label, a.decimals);
  }
  return [...out.values()];
}

/** "480.5 AGIX" for a unit, with what the options know of it. */
export function formatFundingAmount(unit: string, amount: string, options: readonly FundingTokenOption[]): string {
  const token = options.find((o) => o.unit === unit);
  return formatUnits(amount, token?.decimals ?? 0, token?.ticker ?? tokenFallbackLabel(unit));
}

/** "One-off, expected May 2026" · "Monthly from Jan 2026 to Dec 2026" · "Monthly schedule, Jul 2021 – Apr 2022". */
export function describeCommitment(commitment: FundingCommitmentRow, periods: readonly FundingPeriodRow[]): string {
  const label = (day: string) => periodLabel(day.slice(0, 7), commitment.cadence);
  const cadence = commitment.cadence === "quarterly" ? "Quarterly" : "Monthly";
  if (commitment.kind === "one_off") {
    return commitment.starts_on ? `One-off, expected ${label(commitment.starts_on)}` : "One-off";
  }
  if (commitment.kind === "recurring") {
    const from = `${cadence} from ${label(commitment.starts_on!)}`;
    return commitment.ends_on ? `${from} to ${label(commitment.ends_on)}` : `${from}, no end date`;
  }
  const own = periods.filter((p) => p.commitment_id === commitment.id).map((p) => p.starts_on).sort();
  const first = own[0];
  const last = own[own.length - 1];
  if (!first || !last) return `${cadence} schedule, no periods yet`;
  return first === last ? `${cadence} schedule, ${label(first)}` : `${cadence} schedule, ${label(first)} – ${label(last)}`;
}
