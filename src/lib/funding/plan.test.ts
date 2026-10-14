import { describe, expect, it } from "vitest";
import type { FundingCommitmentRow, FundingPeriodRow } from "@/lib/db/types";
import { commitmentSummary, plannedPeriods, sourceSummary, type FundingInflow } from "./plan";

const AGIX = "f43a62fdc3965df486de8a0d32fe800963589c41b38946602a0dc53541474958";
const NOW = new Date("2026-09-15T00:00:00Z");
const ada = (amount: string) => ({ unit: "lovelace", amount, asset_label: "ADA", decimals: 6 });
const agix = (amount: string) => ({ unit: AGIX, amount, asset_label: "AGIX", decimals: 8 });

function commitment(overrides: Partial<FundingCommitmentRow>): FundingCommitmentRow {
  return {
    id: "c", source_id: "s", community_id: "com", name: "Commitment", url: null, note: null,
    kind: "one_off", cadence: null, starts_on: null, ends_on: null, amounts: [ada("50000000")],
    created_by: "admin", created_at: "", updated_at: "", ...overrides,
  };
}

function inflow(overrides: Partial<FundingInflow>): FundingInflow {
  return {
    txHash: "tx", blockTime: "2026-09-10T00:00:00Z", sourceId: "s", commitmentId: "c",
    amountLovelace: "0", assets: null, ...overrides,
  };
}

describe("one-off commitments", () => {
  it("is due once its expected month has come, or at once without one", () => {
    const later = commitmentSummary(commitment({ starts_on: "2026-12-01" }), [], [], NOW);
    expect(later.tokens).toEqual([{ unit: "lovelace", planned: "50000000", due: "0", received: "0", difference: "0", remaining: "50000000" }]);
    const now = commitmentSummary(commitment({}), [], [inflow({ amountLovelace: "20000000" })], NOW);
    expect(now.tokens[0]).toMatchObject({ due: "50000000", received: "20000000", difference: "-30000000", remaining: "30000000" });
    expect(now.periods).toEqual([]);
  });
});

describe("recurring commitments", () => {
  const monthly = commitment({
    kind: "recurring", cadence: "monthly", starts_on: "2026-06-01", ends_on: "2026-12-01", amounts: [ada("20000000"), agix("500000000000")],
  });

  it("plans every period to its end and is due through the current one", () => {
    expect(plannedPeriods(monthly, [], "2026-09").map((p) => p.start))
      .toEqual(["2026-06", "2026-07", "2026-08", "2026-09", "2026-10", "2026-11", "2026-12"]);
    const summary = commitmentSummary(monthly, [], [], NOW);
    expect(summary.tokens.find((t) => t.unit === "lovelace")).toMatchObject({ planned: "140000000", due: "80000000" });
    expect(summary.tokens.find((t) => t.unit === AGIX)).toMatchObject({ planned: "3500000000000", due: "2000000000000" });
  });

  it("shows a late release as under, then over, with the running difference back at zero", () => {
    const july = { amountLovelace: "20000000", assets: { [AGIX]: "500000000000" } };
    const summary = commitmentSummary(monthly, [], [
      inflow({ ...july, txHash: "a", blockTime: "2026-06-20T00:00:00Z" }),
      inflow({ ...july, txHash: "b", blockTime: "2026-08-02T00:00:00Z" }),
      inflow({ ...july, txHash: "c", blockTime: "2026-08-25T00:00:00Z" }),
    ], NOW);
    const byMonth = Object.fromEntries(summary.periods.map((p) => [p.start, p.runningDifference.lovelace]));
    expect(byMonth["2026-06"]).toBe("0");
    expect(byMonth["2026-07"]).toBe("-20000000");
    expect(byMonth["2026-08"]).toBe("0");
    expect(byMonth["2026-09"]).toBe("-20000000");
    expect(summary.tokens.find((t) => t.unit === "lovelace")).toMatchObject({ received: "60000000", difference: "-20000000" });
  });

  it("has no total when open-ended, and counts quarterly periods by quarter", () => {
    const open = commitmentSummary({ ...monthly, ends_on: null }, [], [], NOW);
    expect(open.tokens[0]).toMatchObject({ planned: null, remaining: null, due: "80000000" });
    const quarterly = commitment({ kind: "recurring", cadence: "quarterly", starts_on: "2026-01-01", amounts: [ada("60000000")] });
    const q = commitmentSummary(quarterly, [], [inflow({ amountLovelace: "60000000", blockTime: "2026-05-01T00:00:00Z" })], NOW);
    expect(q.periods.map((p) => [p.label, p.received.lovelace ?? "0"])).toEqual([["Q1 2026", "0"], ["Q2 2026", "60000000"], ["Q3 2026", "0"]]);
  });
});

describe("schedules", () => {
  const schedule = commitment({ id: "sch", kind: "schedule", cadence: "monthly", amounts: [] });
  const periods: FundingPeriodRow[] = [
    { commitment_id: "sch", starts_on: "2026-08-01", amounts: [agix("22500000000000")] },
    { commitment_id: "sch", starts_on: "2026-09-01", amounts: [agix("22162500000000")] },
    { commitment_id: "sch", starts_on: "2026-10-01", amounts: [agix("21830062500000")] },
    { commitment_id: "other", starts_on: "2026-08-01", amounts: [agix("1")] },
  ];

  it("plans its own periods, always with a total", () => {
    const summary = commitmentSummary(schedule, periods, [
      inflow({ commitmentId: "sch", assets: { [AGIX]: "20000000000000" }, blockTime: "2026-08-15T00:00:00Z" }),
    ], NOW);
    expect(summary.tokens).toEqual([{
      unit: AGIX, planned: "66492562500000", due: "44662500000000", received: "20000000000000",
      difference: "-24662500000000", remaining: "46492562500000",
    }]);
    expect(summary.periods.map((p) => p.start)).toEqual(["2026-08", "2026-09", "2026-10"]);
  });
});

describe("sourceSummary", () => {
  it("sums commitments and adds what arrived tied to the source alone", () => {
    const summary = sourceSummary("s", [
      commitment({ id: "one" }),
      commitment({ id: "two", amounts: [ada("10000000")] }),
      commitment({ id: "elsewhere", source_id: "t" }),
    ], [], [
      inflow({ commitmentId: "one", amountLovelace: "50000000" }),
      inflow({ commitmentId: null, amountLovelace: "5000000" }),
      inflow({ commitmentId: "gone", amountLovelace: "1000000" }),
      inflow({ sourceId: "t", commitmentId: "elsewhere", amountLovelace: "999" }),
    ], NOW);
    expect(summary.commitments.map((c) => c.id)).toEqual(["one", "two"]);
    expect(summary.unassigned).toEqual({ lovelace: "6000000" });
    expect(summary.tokens).toEqual([{
      unit: "lovelace", planned: "60000000", due: "60000000", received: "56000000", difference: "-4000000", remaining: "4000000",
    }]);
  });
});
