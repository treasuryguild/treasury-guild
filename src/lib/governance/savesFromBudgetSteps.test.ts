import { describe, expect, it } from "vitest";
import { budgetOwnerKey, savesFromBudgetSteps, type BudgetStep } from "./payload";

const step = (patch: Partial<BudgetStep> = {}): BudgetStep => ({
  workgroupId: "wg-1",
  treasuryId: null,
  mode: "monthly",
  cadence: "monthly",
  startsOn: "2026-10-01",
  amounts: [{ unit: "lovelace", amount: "5000000000", asset_label: "ADA", decimals: 6 }],
  confirm: false,
  reason: "Growth",
  ...patch,
});

describe("savesFromBudgetSteps", () => {
  it("rebuilds create-API saves with each owner's revision and YYYY-MM startsOn", () => {
    const treasury = step({
      workgroupId: null, treasuryId: "t-1", mode: "recurring", cadence: "quarterly",
      startsOn: "2026-10-01", confirm: true, reason: "Ops",
      amounts: [
        { unit: "lovelace", amount: "1000000", asset_label: "ADA", decimals: 6 },
        { unit: "abc", amount: "10", asset_label: "TOK", decimals: 0 },
      ],
    });
    const revisions = new Map([
      [budgetOwnerKey({ workgroupId: "wg-1", treasuryId: null }), 3],
      [budgetOwnerKey({ workgroupId: null, treasuryId: "t-1" }), 0],
    ]);
    expect(savesFromBudgetSteps([step(), treasury], revisions)).toEqual([
      {
        workgroupId: "wg-1",
        budgetMonth: null,
        budgetCadence: "monthly",
        budgets: [{ cadence: "monthly", unit: "lovelace", amount: "5000000000" }],
        expectedRevision: 3,
        mode: "monthly",
        startsOn: "2026-10",
        confirmTransition: false,
        reason: "Growth",
      },
      {
        treasuryId: "t-1",
        budgetMonth: null,
        budgetCadence: "quarterly",
        budgets: [
          { cadence: "quarterly", unit: "lovelace", amount: "1000000" },
          { cadence: "quarterly", unit: "abc", amount: "10" },
        ],
        expectedRevision: 0,
        mode: "recurring",
        startsOn: "2026-10",
        confirmTransition: true,
        reason: "Ops",
      },
    ]);
  });
});
