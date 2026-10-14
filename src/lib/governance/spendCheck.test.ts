import { describe, expect, it } from "vitest";
import type { BudgetInForce } from "@/lib/budgetSetups";
import { spendCheck, spendKey, spendProblemText, type SpendLine, type SpentAmount } from "./spendCheck";

const WG = "w:11111111-1111-4111-8111-111111111111";
const ADA = { unit: "lovelace", ticker: "ADA", decimals: 6 };
const GVTT = { unit: `${"a".repeat(56)}47565454`, ticker: "GVTT", decimals: 0 };

function line(patch: Partial<SpendLine> & Pick<SpendLine, "amount">): SpendLine {
  return { ownerKey: WG, ownerName: "Dev", periodMonth: "2026-09", ...ADA, ...patch };
}

function budget(patch: Partial<BudgetInForce> = {}): BudgetInForce {
  return {
    setupId: "s1", periodMonth: "2026-09", cadence: "monthly", proposalId: "p-1",
    amounts: [{ unit: ADA.unit, amount: "100000000", asset_label: "ADA", decimals: 6 }],
    ...patch,
  };
}

const budgets = (b: BudgetInForce | null) => new Map([[spendKey(WG, "2026-09"), b]]);
const spent = (unit: string, amount: bigint): SpentAmount => ({ ownerKey: WG, periodMonth: "2026-09", unit, amount });

describe("spendCheck", () => {
  it("passes a spend that fits, even when it fills the budget exactly", () => {
    expect(spendCheck({ lines: [line({ amount: 60_000_000n })], budgets: budgets(budget()), spent: [spent("lovelace", 40_000_000n)] }))
      .toEqual([]);
  });

  it("reports one no_budget per owner and period when nothing was budgeted", () => {
    const problems = spendCheck({
      lines: [line({ amount: 1n }), line({ amount: 1n, ...GVTT }), line({ amount: 1n, periodMonth: "2026-10" })],
      budgets: budgets(null), spent: [],
    });
    expect(problems).toEqual([
      { code: "no_budget", ownerKey: WG, ownerName: "Dev", period: "2026-09" },
      { code: "no_budget", ownerKey: WG, ownerName: "Dev", period: "2026-10" },
    ]);
  });

  it("sums the lines of one asset and reports the overrun with what was already spent", () => {
    const problems = spendCheck({
      lines: [line({ amount: 30_000_000n }), line({ amount: 30_000_000n })],
      budgets: budgets(budget()), spent: [spent("lovelace", 50_000_000n)],
    });
    expect(problems).toEqual([{
      code: "over_budget", ownerKey: WG, ownerName: "Dev", period: "2026-09", unit: "lovelace", ticker: "ADA", decimals: 6,
      amount: "60000000", budget: "100000000", spent: "50000000",
    }]);
    expect(spendProblemText(problems[0]!)).toBe(
      "Dev would go over its 2026-09 budget of 100 ADA: 50 ADA already spent, 60 ADA in this transaction.",
    );
  });

  it("treats an asset the budget does not list as budgeted at zero, per asset", () => {
    const problems = spendCheck({ lines: [line({ amount: 1n }), line({ amount: 5n, ...GVTT })], budgets: budgets(budget()), spent: [] });
    expect(problems).toEqual([expect.objectContaining({ code: "over_budget", unit: GVTT.unit, ticker: "GVTT", budget: "0", amount: "5" })]);
  });

  it("flags a budget that was saved directly, and still checks the amounts", () => {
    const problems = spendCheck({
      lines: [line({ amount: 200_000_000n })], budgets: budgets(budget({ proposalId: null })), spent: [],
    });
    expect(problems.map((p) => p.code)).toEqual(["budget_not_voted", "over_budget"]);
    expect(spendProblemText(problems[0]!)).toBe("The 2026-09 budget of Dev was set directly, not by a proposal.");
  });

  it("writes the period as the chain does: a quarter for a quarterly budget", () => {
    const quarterly = budget({ cadence: "quarterly", periodMonth: "2026-07", proposalId: null });
    const problems = spendCheck({
      lines: [line({ amount: 1n, periodMonth: "2026-07" })],
      budgets: new Map([[spendKey(WG, "2026-07"), quarterly]]), spent: [],
    });
    expect(problems).toEqual([{ code: "budget_not_voted", ownerKey: WG, ownerName: "Dev", period: "2026-Q3" }]);
    expect(spendProblemText({ code: "no_budget", ownerKey: WG, ownerName: "Dev", period: "2026-Q3" })).toBe("Dev has no budget for 2026-Q3.");
  });

  it("nets refunds out of what was spent", () => {
    const problems = spendCheck({
      lines: [line({ amount: 60_000_000n })], budgets: budgets(budget()),
      spent: [spent("lovelace", 50_000_000n), spent("lovelace", -20_000_000n)],
    });
    expect(problems).toEqual([]);
  });
});
