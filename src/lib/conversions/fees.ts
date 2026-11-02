// Pure fee totals for bridge/swap conversion episodes. Amounts are exact
// decimal strings under a free-text asset label (not on-chain units); sums
// pad to the widest fraction in the group (at most 30) then format back.

import { formatQuantity, scaleDecimal } from "@/lib/assets";

export interface ConversionFeeLine {
  amount: string;
  assetLabel: string;
  chain: string | null;
}

/** One total cell shown on Funding / Dashboard. */
export interface ConversionFeeTotal {
  assetLabel: string;
  amount: string;
  chain: string | null;
}

const KEY = "|";

function fractionDigits(amount: string): number {
  const dot = amount.indexOf(".");
  return dot < 0 ? 0 : amount.length - dot - 1;
}

/**
 * Sum fee lines by (assetLabel, chain). Window filtering is the caller's job
 * (episodes whose linked inflow block_time is in range).
 */
export function sumConversionFees(fees: readonly ConversionFeeLine[]): ConversionFeeTotal[] {
  const groups = new Map<string, { assetLabel: string; chain: string | null; amounts: string[] }>();
  for (const fee of fees) {
    const key = `${fee.assetLabel}${KEY}${fee.chain ?? ""}`;
    const group = groups.get(key) ?? { assetLabel: fee.assetLabel, chain: fee.chain, amounts: [] };
    group.amounts.push(fee.amount);
    groups.set(key, group);
  }
  return [...groups.values()]
    .map((group) => {
      const decimals = Math.max(0, ...group.amounts.map(fractionDigits));
      let total = 0n;
      for (const amount of group.amounts) total += scaleDecimal(amount, decimals);
      return { assetLabel: group.assetLabel, chain: group.chain, amount: formatQuantity(total, decimals) };
    })
    .sort((a, b) => a.assetLabel.localeCompare(b.assetLabel) || (a.chain ?? "").localeCompare(b.chain ?? ""));
}
