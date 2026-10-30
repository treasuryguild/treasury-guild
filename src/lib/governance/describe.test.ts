import { describe, expect, it } from "vitest";
import { budgetStepText, proposalChangeLines } from "./describe";
import type { BudgetStep } from "./payload";

const names = {
  owner: (id: string) => ({ w1: "Design", t1: "Main" } as Record<string, string>)[id],
  member: (wallet: string) => ({ a: "ana", b: "ben" } as Record<string, string>)[wallet] ?? wallet,
};

describe("proposalChangeLines", () => {
  it("lists each budget change with its owner", () => {
    expect(proposalChangeLines({ proposer: "a", payload: { steps: [
      { workgroupId: "w1", treasuryId: null, mode: "recurring", cadence: "monthly", startsOn: "2026-10-01", confirm: false, reason: "",
        amounts: [{ unit: "lovelace", amount: "2500000000", asset_label: "ADA", decimals: 6 }] },
      { workgroupId: null, treasuryId: "t1", mode: "quarterly", cadence: "quarterly", startsOn: "2026-10-01", confirm: true, reason: "",
        amounts: [{ unit: "lovelace", amount: "900000000", asset_label: "ADA", decimals: 6 }] },
    ] } }, names)).toEqual([
      "Design: Recurring monthly budget from 2026-10: 2,500 ADA",
      "Treasury Main: Q4 2026: 900 ADA (changes the budget setup)",
    ]);
  });

  it("describes a new workgroup and a task", () => {
    expect(proposalChangeLines({ proposer: "a", payload: {
      workgroup: { name: "Research", description: "", leads: ["a", "b"] }, columns: [],
    } }, names)).toEqual(["Creates the workgroup Research (app board), led by ana, ben"]);
    expect(proposalChangeLines({ proposer: "b", payload: {
      task: { workgroupId: "w1", amounts: { ADA: "120", GVTT: "5" }, bountyLovelace: "120000000", assignSelf: true },
    } }, names)).toEqual(["Adds the task to Design, paying 120 ADA + 5 GVTT per assignee, assigned to ben"]);
    expect(proposalChangeLines({ proposer: "a", payload: {} }, names)).toEqual([]);
    expect(proposalChangeLines({ proposer: "a", payload: {
      leadChange: { workgroupId: "w1", add: ["a"], remove: ["b"], escalation: null, escalates: null },
    } }, names)).toEqual([
      "Adds ana as a lead of Design",
      "Removes ben as a lead of Design",
    ]);
  });
});

describe("budgetStepText", () => {
  const ada = (amount: string) => ({ unit: "lovelace", amount, asset_label: "ADA", decimals: 6 });
  const step = (over: Partial<BudgetStep>): BudgetStep => ({
    workgroupId: "w1", treasuryId: null, mode: "recurring", cadence: "monthly", startsOn: "2026-09-01",
    confirm: false, reason: "", amounts: [ada("2500000000")], ...over,
  });

  it("describes a recurring budget by its cadence and first month", () => {
    expect(budgetStepText(step({}))).toBe("Recurring monthly budget from 2026-09: 2,500 ADA");
    expect(budgetStepText(step({ cadence: "quarterly", startsOn: "2026-10-01" }))).toBe("Recurring quarterly budget from 2026-10: 2,500 ADA");
  });

  it("describes a planned period by its label: a month, or a quarter", () => {
    expect(budgetStepText(step({ mode: "monthly", startsOn: "2026-07-01" }))).toBe("Jul 2026: 2,500 ADA");
    expect(budgetStepText(step({ mode: "quarterly", cadence: "quarterly", startsOn: "2026-10-01", amounts: [ada("900000000")] })))
      .toBe("Q4 2026: 900 ADA");
    // The start date's day is ignored; only its month names the period.
    expect(budgetStepText(step({ mode: "monthly", startsOn: "2026-07" }))).toBe("Jul 2026: 2,500 ADA");
  });

  it("lists every token, exactly, and says when a step clears the allocations", () => {
    const amounts = [ada("1500000"), { unit: "u", amount: "350000", asset_label: "GVTT", decimals: 2 }, { unit: "abc", amount: "7", asset_label: null, decimals: 0 }];
    expect(budgetStepText(step({ amounts }))).toBe("Recurring monthly budget from 2026-09: 1.5 ADA, 3,500 GVTT, 7 abc");
    expect(budgetStepText(step({ amounts: [] }))).toBe("Recurring monthly budget from 2026-09: no allocations");
    expect(budgetStepText(step({ mode: "monthly", amounts: [] }))).toBe("Sep 2026: no allocations");
  });

  it("says nothing of the owner, the reason or the setup change: the line around it does", () => {
    const text = budgetStepText(step({ workgroupId: null, treasuryId: "t1", confirm: true, reason: "New grant" }));
    expect(text).toBe(budgetStepText(step({})));
  });
});
