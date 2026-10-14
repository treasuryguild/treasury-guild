import { describe, expect, it } from "vitest";
import type { BudgetStep } from "./payload";
import { fundBudgetPrefill, fundingPeriod, isAppliedBudgetProposal } from "./fundBudget";

const WG = "20000000-0000-0000-0000-000000000001";
const OPS = "40000000-0000-0000-0000-000000000002";
const applied = { id: "p1", state: "passed", execution_state: "applied" } as const;
const step = (patch: Partial<BudgetStep> = {}): BudgetStep => ({
  workgroupId: WG, treasuryId: null, mode: "monthly", cadence: "monthly", startsOn: "2026-10-01",
  amounts: [
    { unit: "lovelace", amount: "2500000000", asset_label: "ADA", decimals: 6 },
    { unit: `${"a".repeat(56)}47565454`, amount: "10500000", asset_label: "GVTT", decimals: 6 },
  ],
  confirm: false, reason: "", ...patch,
});
const routed = new Map([[WG, [{ treasury_id: OPS, starts_on: "2026-01-01" }]]]);

describe("fundingPeriod", () => {
  it("is the step's own period, or the current one of a recurring step that already started", () => {
    expect(fundingPeriod(step(), "2026-12-15")).toBe("2026-10");
    expect(fundingPeriod(step({ mode: "quarterly", cadence: "quarterly", startsOn: "2026-11-01" }), "2026-12-15")).toBe("2026-10");
    expect(fundingPeriod(step({ mode: "recurring", startsOn: "2026-08-01" }), "2026-12-15")).toBe("2026-12");
    expect(fundingPeriod(step({ mode: "recurring", startsOn: "2027-02-01" }), "2026-12-15")).toBe("2027-02");
    expect(fundingPeriod(step({ mode: "recurring", cadence: "quarterly", startsOn: "2026-01-01" }), "2026-11-15")).toBe("2026-10");
  });
});

describe("fundBudgetPrefill", () => {
  it("links to a transfer of the period's amounts to the routed treasury, citing the proposal", () => {
    expect(fundBudgetPrefill(step(), applied, routed, 2, "2026-10-05")).toEqual({
      treasuryId: OPS, month: "2026-10", proposalId: "p1",
      amounts: { lovelace: "2500", [`${"a".repeat(56)}47565454`]: "10.5" },
    });
  });

  it("is not offered before the proposal is applied, for treasury budgets, unrouted workgroups or one treasury", () => {
    expect(fundBudgetPrefill(step(), { ...applied, execution_state: "pending" }, routed, 2, "2026-10-05")).toBeNull();
    expect(fundBudgetPrefill(step(), { ...applied, state: "rejected", execution_state: "not_applicable" }, routed, 2, "2026-10-05")).toBeNull();
    expect(fundBudgetPrefill(step({ workgroupId: null, treasuryId: OPS }), applied, routed, 2, "2026-10-05")).toBeNull();
    expect(fundBudgetPrefill(step(), applied, new Map(), 2, "2026-10-05")).toBeNull();
    expect(fundBudgetPrefill(step(), applied, new Map([[WG, [{ treasury_id: null, starts_on: "2026-01-01" }]]]), 2, "2026-10-05")).toBeNull();
    expect(fundBudgetPrefill(step(), applied, routed, 1, "2026-10-05")).toBeNull();
    expect(fundBudgetPrefill(step({ amounts: [] }), applied, routed, 2, "2026-10-05")).toBeNull();
    // A routing that starts after the period does not apply to it.
    expect(fundBudgetPrefill(step(), applied, new Map([[WG, [{ treasury_id: OPS, starts_on: "2026-11-01" }]]]), 2, "2026-10-05")).toBeNull();
  });

  it("knows an applied budget proposal", () => {
    expect(isAppliedBudgetProposal(applied)).toBe(true);
    expect(isAppliedBudgetProposal({ state: "passed", execution_state: "failed" })).toBe(false);
  });
});
