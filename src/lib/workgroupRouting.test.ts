import { describe, expect, it } from "vitest";
import { routedTreasuryAt, routingPeriod } from "./workgroupRouting";

const timeline = [
  { treasury_id: "main", starts_on: "1000-01-01" },
  { treasury_id: "dev", starts_on: "2026-10-01" },
  { treasury_id: null, starts_on: "2027-01-01" },
];

describe("routedTreasuryAt", () => {
  it("resolves the assignment in force for a period", () => {
    expect(routedTreasuryAt(timeline, "2026-09")).toBe("main");
    expect(routedTreasuryAt(timeline, "2026-10")).toBe("dev");
    expect(routedTreasuryAt(timeline, "2026-12")).toBe("dev");
  });

  it("treats a null assignment as any wallet", () => {
    expect(routedTreasuryAt(timeline, "2027-03")).toBeNull();
  });

  it("is null before the first assignment and for an empty timeline", () => {
    expect(routedTreasuryAt([{ treasury_id: "dev", starts_on: "2026-10-01" }], "2026-09")).toBeNull();
    expect(routedTreasuryAt([], "2026-09")).toBeNull();
  });

  it("does not depend on row order", () => {
    expect(routedTreasuryAt([...timeline].reverse(), "2026-11")).toBe("dev");
  });
});

describe("routingPeriod", () => {
  it("defaults to the calendar month without a setup", () => {
    expect(routingPeriod([], "2026-09")).toEqual({ cadence: "monthly", currentStart: "2026-09", nextStart: "2026-10" });
  });

  it("aligns a quarterly workgroup to its quarter", () => {
    const setups = [{ starts_on: "2026-01-01", cadence: "quarterly" as const }];
    expect(routingPeriod(setups, "2026-08")).toEqual({ cadence: "quarterly", currentStart: "2026-07", nextStart: "2026-10" });
    expect(routingPeriod(setups, "2026-12")).toEqual({ cadence: "quarterly", currentStart: "2026-10", nextStart: "2027-01" });
  });

  it("uses the setup in force today, not a future one", () => {
    const setups = [{ starts_on: "2027-01-01", cadence: "quarterly" as const }];
    expect(routingPeriod(setups, "2026-08").cadence).toBe("monthly");
  });
});
