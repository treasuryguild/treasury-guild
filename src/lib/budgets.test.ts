import { afterEach, describe, expect, it, vi } from "vitest";
import {
  BudgetCadence,
  alignBudgetMonth,
  budgetAssetOptions,
  budgetAttributionTime,
  budgetMonthFromQuery,
  budgetMonthFromPeriodCode,
  budgetPeriod,
  budgetPeriodCode,
  budgetTokenLabel,
  budgetUsagePercent,
  currentBudgetMonth,
  isFutureBudgetMonth,
  currentPeriodStart,
  effectiveBudgets,
  inBudgetPeriod,
  isPastPeriod,
  monthDate,
  monthOf,
  nextQuarterStart,
  periodLabel,
  quarterCode,
  quarterLabel,
  quarterMonths,
  quarterStartMonth,
  shiftMonth,
  shortMonthLabel,
} from "./budgets";

describe("current period", () => {
  afterEach(() => vi.useRealTimers());
  it("treats a quarter as current until its last month ends, a month until it ends", () => {
    vi.useFakeTimers({ toFake: ["Date"] }); vi.setSystemTime(new Date("2026-09-09T00:00:00Z"));
    expect(currentPeriodStart("monthly")).toBe("2026-09");
    expect(currentPeriodStart("quarterly")).toBe("2026-07");
    expect(isPastPeriod("2026-07", "quarterly")).toBe(false);
    expect(isPastPeriod("2026-08", "quarterly")).toBe(false);
    expect(isPastPeriod("2026-04", "quarterly")).toBe(true);
    expect(isPastPeriod("2026-08", "monthly")).toBe(true);
    expect(isPastPeriod("2026-09", "monthly")).toBe(false);
    expect(isPastPeriod("2026-08", null)).toBe(true);
  });
  it("walks months and labels them", () => {
    expect(shiftMonth("2026-12", 1)).toBe("2027-01");
    expect(shiftMonth("2026-01", -3)).toBe("2025-10");
    expect(quarterMonths("2026-08")).toEqual(["2026-07", "2026-08", "2026-09"]);
    expect(shortMonthLabel("2026-07")).toBe("Jul 2026");
  });
});

describe("quarter helpers", () => {
  it("maps any month to the first month of its quarter", () => {
    expect(quarterStartMonth("2026-01")).toBe("2026-01");
    expect(quarterStartMonth("2026-05")).toBe("2026-04");
    expect(quarterStartMonth("2026-12")).toBe("2026-10");
    expect(quarterStartMonth("garbage")).toBe("garbage");
  });
  it("names the quarter containing a month", () => {
    expect(quarterCode("2026-01")).toBe("2026-Q1");
    expect(quarterCode("2026-05")).toBe("2026-Q2");
    expect(quarterCode("2026-09")).toBe("2026-Q3");
    expect(quarterCode("2026-12")).toBe("2026-Q4");
    expect(quarterCode("garbage")).toBe("garbage");
  });
  it("aligns a month and names its on-chain period by cadence", () => {
    expect(alignBudgetMonth("2026-05", BudgetCadence.Quarterly)).toBe("2026-04");
    expect(alignBudgetMonth("2026-05", BudgetCadence.Monthly)).toBe("2026-05");
    expect(alignBudgetMonth("2026-05", null)).toBe("2026-05");
    expect(budgetPeriodCode("2026-05", BudgetCadence.Quarterly)).toBe("2026-Q2");
    expect(budgetPeriodCode("2026-05", BudgetCadence.Monthly)).toBe("2026-05");
    expect(budgetPeriodCode("2026-05", null)).toBe("2026-05");
  });
});

describe("budgetPeriod", () => {
  it("includes the first instant and excludes the next month with database timestamp formats", () => {
    const { start, end } = budgetPeriod("monthly", new Date("2026-09-01T00:00:00Z"));
    expect(inBudgetPeriod("2026-09-01T00:00:00+00:00", start, end)).toBe(true);
    expect(inBudgetPeriod("2026-09-01T02:00:00+02:00", start, end)).toBe(true);
    expect(inBudgetPeriod("2026-08-31T23:59:59Z", start, end)).toBe(false);
    expect(inBudgetPeriod("2026-10-01T00:00:00+00:00", start, end)).toBe(false);
    expect(inBudgetPeriod("2026-09-30T23:59:59Z", start, end)).toBe(true);
  });
  it("uses leap-year February and an exclusive end date", () => {
    const period = budgetPeriod("monthly", new Date("2028-02-29T23:59:59Z"));
    expect(period.start).toBe("2028-02-01T00:00:00.000Z");
    expect(period.end).toBe("2028-03-01T00:00:00.000Z");
  });
  it("returns the current calendar month", () => {
    expect(
      budgetPeriod(BudgetCadence.Monthly, new Date("2026-09-18T12:00:00Z")),
    ).toEqual({
      start: "2026-09-01T00:00:00.000Z",
      end: "2026-10-01T00:00:00.000Z",
      label: "September 2026",
    });
  });

  it("returns the current calendar quarter across a year boundary", () => {
    expect(
      budgetPeriod(BudgetCadence.Quarterly, new Date("2026-12-03T00:00:00Z")),
    ).toEqual({
      start: "2026-10-01T00:00:00.000Z",
      end: "2027-01-01T00:00:00.000Z",
      label: "Q4 2026",
    });
  });
});

describe("effectiveBudgets", () => {
  const recurring = { workgroup_id: "design", unit: "lovelace", budget_month: null, amount: "100", cadence: "monthly" as const };
  const september = { ...recurring, budget_month: "2026-09-01", amount: "200" };
  const october = { ...recurring, budget_month: "2026-10-01", amount: "300" };

  it("keeps allocations separate across months without double counting defaults", () => {
    const budgets = [recurring, september, october];
    expect(effectiveBudgets(budgets, "2026-09")).toEqual([september]);
    expect(effectiveBudgets(budgets, "2026-10")).toEqual([october]);
    expect(effectiveBudgets(budgets, "2026-11")).toEqual([recurring]);
  });

  it("only overrides the matching project and token", () => {
    const otherProject = { ...recurring, workgroup_id: "engineering" };
    const otherToken = { ...recurring, unit: "token" };
    expect(effectiveBudgets([recurring, otherProject, otherToken, september], "2026-09"))
      .toEqual([september, otherProject, otherToken]);
  });

  it("does not carry a dated budget into another month", () => {
    expect(effectiveBudgets([september], "2026-10")).toEqual([]);
  });

  it("separates monthly and quarterly allocations with the same start date", () => {
    const monthly = { ...recurring, budget_month: "2026-10-01", amount: "150" };
    const quarterly = { ...monthly, cadence: "quarterly" as const, amount: "500" };
    const defaultQuarter = { ...quarterly, budget_month: null, amount: "400" };
    const budgets = [recurring, defaultQuarter, monthly, quarterly];
    expect(effectiveBudgets(budgets, "2026-10", "monthly")).toEqual([monthly]);
    expect(effectiveBudgets(budgets, "2026-10", "quarterly")).toEqual([quarterly]);
    expect(effectiveBudgets(budgets, "2027-01", "quarterly")).toEqual([defaultQuarter]);
  });
});

describe("budgetUsagePercent", () => {
  it("calculates and caps utilization", () => {
    expect(budgetUsagePercent(25n, 100n)).toBe(25);
    expect(budgetUsagePercent(150n, 100n)).toBe(100);
  });
});

describe("budgetAssetOptions", () => {
  it("merges wallet tokens with ADA and stable known assets by unit", () => {
    expect(
      budgetAssetOptions(
        [{ fieldName: "KNOWN", unit: "a".repeat(56), decimals: 2 }],
        [
          {
            unit: "a".repeat(56),
            quantity: "100",
            ticker: "NEW NAME",
            name: null,
            decimals: 9,
            source: "registry",
          },
          {
            unit: "b".repeat(56),
            quantity: "200",
            ticker: "FRESH",
            name: null,
            decimals: 4,
            source: "registry",
          },
        ],
      ),
    ).toEqual([
      { fieldName: "ADA", unit: "lovelace", decimals: 6 },
      { fieldName: "NEW NAME", unit: "a".repeat(56), decimals: 9 },
      { fieldName: "FRESH", unit: "b".repeat(56), decimals: 4 },
    ]);
  });

  it("uses a compact unit fallback and caps metadata labels at 32 bytes", () => {
    expect(
      budgetTokenLabel({ unit: "c".repeat(56), ticker: null, name: null }),
    ).toBe("TOKEN-CCCCCC");
    expect(
      new TextEncoder().encode(
        budgetTokenLabel({
          unit: "d".repeat(56),
          ticker: null,
          name: "A long token name that cannot fit inside the label",
        }),
      ).length,
    ).toBeLessThanOrEqual(32);
  });

  it("uses the encoded asset name before falling back to a policy prefix", () => {
    expect(
      budgetTokenLabel({
        unit: "e".repeat(56) + "47565454",
        ticker: null,
        name: null,
      }),
    ).toBe("GVTT");
  });
});

describe("budgetMonthFromPeriodCode", () => {
  it("inverts budgetPeriodCode: a month, or a quarter's first month", () => {
    expect(budgetMonthFromPeriodCode("2026-09")).toBe("2026-09-01");
    expect(budgetMonthFromPeriodCode("2026-Q1")).toBe("2026-01-01");
    expect(budgetMonthFromPeriodCode("2026-Q3")).toBe("2026-07-01");
    expect(budgetMonthFromPeriodCode(budgetPeriodCode("2026-11", BudgetCadence.Quarterly))).toBe("2026-10-01");
  });

  it("is null for anything else", () => {
    for (const bad of ["", "2026-13", "2026-Q5", "2026-9", "soon"]) {
      expect(budgetMonthFromPeriodCode(bad)).toBeNull();
    }
  });
});

describe("month helpers", () => {
  it("reads the UTC month of dates and timestamps", () => {
    expect(monthOf("2026-09-01")).toBe("2026-09");
    expect(monthOf("2026-09-01T01:00:00+02:00")).toBe("2026-08");
    expect(monthOf(new Date(Date.UTC(2026, 11, 31, 23, 59)))).toBe("2026-12");
    expect(monthDate("2026-07").toISOString()).toBe("2026-07-01T00:00:00.000Z");
  });

  it("rounds up to a quarter start", () => {
    expect(nextQuarterStart("2026-07")).toBe("2026-07");
    expect(nextQuarterStart("2026-08")).toBe("2026-10");
    expect(nextQuarterStart("2026-12")).toBe("2027-01");
  });

  it("labels a period by its cadence", () => {
    expect(periodLabel("2026-08", "monthly")).toBe("Aug 2026");
    expect(periodLabel("2026-08", "quarterly")).toBe("Q3 2026");
    expect(periodLabel("2026-08", null)).toBe("Aug 2026");
    expect(quarterLabel("2026-01")).toBe("Q1 2026");
  });
});

describe("current budget month", () => {
  afterEach(() => vi.useRealTimers());

  it("is the UTC calendar month of now, turning over at UTC midnight", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-30T23:59:59.999Z"));
    expect(currentBudgetMonth()).toBe("2026-09");
    vi.setSystemTime(new Date("2026-10-01T00:00:00Z"));
    expect(currentBudgetMonth()).toBe("2026-10");
    // Still December somewhere west of Greenwich, already January in UTC.
    vi.setSystemTime(new Date("2026-12-31T23:30:00-05:00"));
    expect(currentBudgetMonth()).toBe("2027-01");
  });

  it("flags a month strictly after the current budget month as future", () => {
    expect(isFutureBudgetMonth("2026-10", "2026-10")).toBe(false);
    expect(isFutureBudgetMonth("2026-09", "2026-10")).toBe(false);
    expect(isFutureBudgetMonth("2026-11", "2026-10")).toBe(true);
    expect(isFutureBudgetMonth("2030-01", "2026-10")).toBe(true);
  });

  it("reads a month from a query value, else falls back to the current month", () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-09T00:00:00Z"));
    expect(budgetMonthFromQuery("2025-01")).toBe("2025-01");
    expect(budgetMonthFromQuery("2031-12")).toBe("2031-12");
    for (const bad of ["2026-13", "2026-00", "2026-9", "2026-09-01", "0999-01", " 2026-08", "", "latest", 202608, null, undefined, ["2026-08"], { month: "2026-08" }]) {
      expect(budgetMonthFromQuery(bad), JSON.stringify(bad)).toBe("2026-09");
    }
  });
});

describe("budgetAttributionTime", () => {
  const submittedAt = "2026-09-12T10:00:00Z";
  const createdAt = "2026-09-10T08:00:00Z";

  it("prefers the assigned budget month, then the submission, then the creation", () => {
    expect(budgetAttributionTime({ budgetMonth: "2026-07-01", submittedAt, createdAt })).toBe("2026-07-01");
    expect(budgetAttributionTime({ budgetMonth: null, submittedAt, createdAt })).toBe(submittedAt);
    expect(budgetAttributionTime({ budgetMonth: null, submittedAt: null, createdAt })).toBe(createdAt);
  });

  it("puts a task paid in a later month into its budget month's period", () => {
    const september = budgetPeriod("monthly", new Date("2026-09-15T00:00:00Z"));
    const paidLate = { budgetMonth: "2026-09-01", submittedAt: "2026-10-03T09:00:00Z", createdAt: "2026-10-03T08:00:00Z" };
    expect(inBudgetPeriod(budgetAttributionTime(paidLate), september.start, september.end)).toBe(true);
    // Without a budget month the same payout counts when it was submitted.
    expect(inBudgetPeriod(budgetAttributionTime({ ...paidLate, budgetMonth: null }), september.start, september.end)).toBe(false);
  });
});
