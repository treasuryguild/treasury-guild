// Pure logic of the Payments page form: recipient rows as typed, the request
// they become, and the checks shown before building (the route re-derives
// everything from the wallet and never trusts the client). Client-safe.

import type { BuildPaymentBody } from "@/lib/api/schemas";
import type { BudgetSummary, WalletAssetsResponse } from "@/lib/api/types";
import { ADA_ASSET, addQuantity, LOVELACE, scaleDecimal } from "@/lib/assets";
import { budgetTokenLabel } from "@/lib/budgets";
import { addressToNetwork, checkValidAddress } from "@/lib/cardano/multisigSDK";
import type { Network } from "@/lib/config";
import { MAX_PAYOUT_CONTRIBUTORS } from "@/lib/constants";
import { shortUnit } from "@/lib/format";

export type RecipientKind = "member" | "treasury" | "address";

export interface RecipientDraft {
  key: number;
  kind: RecipientKind;
  /** The address paid: a member's wallet, a sibling treasury's address, or typed. */
  address: string;
  /** unit -> display amount as typed ("" = none). */
  amounts: Record<string, string>;
}

/** A token the paying treasury holds, as the amount inputs see it. ADA first. */
export interface DraftToken {
  unit: string;
  ticker: string;
  decimals: number;
  /** Base units held by the treasury. */
  held: bigint;
}

export function newRecipient(key: number, kind: RecipientKind = "member"): RecipientDraft {
  return { key, kind, address: "", amounts: {} };
}

export function walletTokens(wallet: WalletAssetsResponse | null | undefined): DraftToken[] {
  if (!wallet) return [];
  return [
    { unit: LOVELACE, ticker: ADA_ASSET.fieldName, decimals: ADA_ASSET.decimals, held: BigInt(wallet.lovelace) },
    ...wallet.tokens.map((token) => ({
      unit: token.unit, ticker: budgetTokenLabel(token), decimals: token.decimals, held: BigInt(token.quantity),
    })),
  ];
}

const AMOUNT_RE = /^\d+(?:\.\d+)?$/;

/** The request body's recipients: trimmed addresses, blank amounts dropped. */
export function draftToRequest(rows: readonly RecipientDraft[]): BuildPaymentBody["recipients"] {
  return rows.map((row) => ({
    address: row.address.trim(),
    amounts: Object.fromEntries(Object.entries(row.amounts)
      .map(([unit, amount]) => [unit, amount.trim()])
      .filter(([, amount]) => amount !== "")),
  }));
}

/** Sum of the well-formed amounts per unit (malformed ones are reported by `draftProblems`). */
export function draftTotals(rows: readonly RecipientDraft[], tokens: readonly DraftToken[]): Map<string, bigint> {
  const decimals = new Map(tokens.map((t) => [t.unit, t.decimals]));
  const totals = new Map<string, bigint>();
  for (const row of rows) {
    for (const [unit, raw] of Object.entries(row.amounts)) {
      const amount = raw.trim();
      const scale = decimals.get(unit);
      if (amount === "" || scale === undefined || !AMOUNT_RE.test(amount)) continue;
      try {
        addQuantity(totals, unit, scaleDecimal(amount, scale));
      } catch {
        // Too many decimals: reported as a problem, not summed.
      }
    }
  }
  return totals;
}

/** Tickers whose total exceeds what the treasury holds. */
export function overBalance(totals: ReadonlyMap<string, bigint>, tokens: readonly DraftToken[]): string[] {
  return tokens.filter((t) => (totals.get(t.unit) ?? 0n) > t.held).map((t) => t.ticker);
}

/**
 * What stops the build, in row order: every recipient needs a valid address
 * on the community's network that is not the paying treasury, and at least
 * one well-formed positive amount.
 */
export function draftProblems(
  rows: readonly RecipientDraft[],
  tokens: readonly DraftToken[],
  ctx: { treasuryAddress: string; network: Network },
): string[] {
  const problems: string[] = [];
  const decimals = new Map(tokens.map((t) => [t.unit, t]));
  rows.forEach((row, index) => {
    const who = `Recipient ${index + 1}`;
    const address = row.address.trim();
    if (!address) {
      problems.push(`${who}: choose who to pay`);
      return;
    }
    if (!checkValidAddress(address)) {
      problems.push(`${who}: not a valid Cardano address`);
      return;
    }
    if (addressToNetwork(address) !== ctx.network) {
      problems.push(`${who}: address is on a different network`);
      return;
    }
    if (address === ctx.treasuryAddress) {
      problems.push(`${who}: this is the paying treasury itself`);
      return;
    }
    let paid = false;
    for (const [unit, raw] of Object.entries(row.amounts)) {
      const amount = raw.trim();
      if (amount === "") continue;
      const token = decimals.get(unit);
      if (!token) {
        // A prefilled amount (a "Fund this budget" link) of a token this wallet does not hold has no input to show it.
        problems.push(`${who}: the paying treasury holds no ${shortUnit(unit)} to pay ${amount} of it`);
        continue;
      }
      if (!AMOUNT_RE.test(amount)) {
        problems.push(`${who}: enter a plain number for ${token.ticker}`);
        continue;
      }
      try {
        if (scaleDecimal(amount, token.decimals) <= 0n) {
          problems.push(`${who}: ${token.ticker} amount must be greater than zero`);
          continue;
        }
      } catch {
        problems.push(`${who}: ${token.ticker} allows at most ${token.decimals} decimal places`);
        continue;
      }
      paid = true;
    }
    if (!paid) problems.push(`${who}: enter an amount`);
  });
  const distinct = new Set(rows.map((row) => row.address.trim()).filter(Boolean));
  if (distinct.size > MAX_PAYOUT_CONTRIBUTORS) {
    problems.push(`At most ${MAX_PAYOUT_CONTRIBUTORS} recipients per payment`);
  }
  return problems;
}

/** One treasury budget of the period beside what this payment adds to it. */
export interface BudgetLine {
  unit: string;
  ticker: string;
  decimals: number;
  periodLabel: string;
  amount: bigint;
  spent: bigint;
  /** This payment's spend of the unit (transfers excluded). */
  adding: bigint;
  /** Balance after this payment; negative when it overspends. */
  after: bigint;
}

/**
 * The paying treasury's budgets in view, with the balance each would have
 * after this payment. Only spend counts: `totals` should exclude transfers.
 */
export function budgetLines(
  budgets: readonly BudgetSummary[],
  treasuryId: string,
  totals: ReadonlyMap<string, bigint>,
): BudgetLine[] {
  return budgets
    .filter((budget) => budget.ownerType === "treasury" && budget.ownerId === treasuryId)
    .map((budget) => {
      const adding = totals.get(budget.unit) ?? 0n;
      const amount = BigInt(budget.amount);
      const spent = BigInt(budget.spent);
      return {
        unit: budget.unit, ticker: budget.assetLabel, decimals: budget.decimals, periodLabel: budget.periodLabel,
        amount, spent, adding, after: amount - spent - adding,
      };
    });
}
