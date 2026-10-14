// Planned amounts: display-unit input scaled exactly to each token's decimals
// and stored with its ticker, like budget amounts. Pure and client-safe.
import { scaleDecimal } from "@/lib/assets";
import type { FundingAmount } from "@/lib/db/types";
import { DomainError } from "@/lib/errors";

export interface FundingToken {
  ticker: string;
  decimals: number;
}

/** [{unit, amount: "211800.72389063"}] → base units; refuses more decimals than a token has. */
export function toFundingAmounts(
  rows: readonly { unit: string; amount: string }[],
  tokens: ReadonlyMap<string, FundingToken>,
): FundingAmount[] {
  return rows.map((row) => {
    const token = tokens.get(row.unit);
    if (!token) throw new DomainError(`Unknown token ${row.unit}`);
    let quantity: bigint;
    try {
      quantity = scaleDecimal(row.amount, token.decimals);
    } catch {
      throw new DomainError(`${row.amount} ${token.ticker} has more decimal places than the token (${token.decimals})`);
    }
    if (quantity <= 0n) throw new DomainError("Amounts must be above zero");
    return { unit: row.unit, amount: quantity.toString(), asset_label: token.ticker, decimals: token.decimals };
  });
}
