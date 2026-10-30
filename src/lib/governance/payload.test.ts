import { describe, expect, it } from "vitest";
import {
  budgetOwnerKey, budgetOwnersOf,   isBudgetPayload, isLeadPayload, isTaskPayload, isWorkgroupPayload, leadChangeNeedsAdmins, switchStartsTooEarly, taskExceedsLazyCap,
} from "./payload";

describe("budgetOwnersOf", () => {
  it("keeps each owner once, with the revision of its first save", () => {
    expect(budgetOwnersOf([
      { workgroupId: "w1", expectedRevision: 3 },
      { workgroupId: "w1", expectedRevision: 4 },
      { treasuryId: "t1", expectedRevision: 0 },
    ])).toEqual([
      { workgroupId: "w1", treasuryId: null, baseRevision: 3 },
      { workgroupId: null, treasuryId: "t1", baseRevision: 0 },
    ]);
  });

  it("keys owners as budget_owner_key does", () => {
    expect(budgetOwnerKey({ workgroupId: "w1", treasuryId: null })).toBe("w:w1");
    expect(budgetOwnerKey({ workgroupId: null, treasuryId: "t1" })).toBe("t:t1");
  });
});

describe("switchStartsTooEarly", () => {
  const endsAt = new Date("2026-10-02T09:00:00Z");
  it("flags a setup change that starts before voting can end", () => {
    expect(switchStartsTooEarly([{ confirm: true, startsOn: "2026-09-01" }], endsAt)).toBe("2026-09");
    expect(switchStartsTooEarly([{ confirm: true, startsOn: "2026-10-01" }], endsAt)).toBeNull();
    // Amount changes of a past period are corrections, not switches.
    expect(switchStartsTooEarly([{ confirm: false, startsOn: "2026-01-01" }], endsAt)).toBeNull();
  });
});

describe("isBudgetPayload", () => {
  it("tells budget steps from an empty decision payload", () => {
    expect(isBudgetPayload({ steps: [] })).toBe(true);
    expect(isBudgetPayload({})).toBe(false);
    expect(isWorkgroupPayload({ workgroup: { name: "x", description: "", leads: [] }, columns: [] })).toBe(true);
    expect(isTaskPayload({ task: { workgroupId: "w", amounts: {}, bountyLovelace: null, assignSelf: false } })).toBe(true);
    expect(isTaskPayload({ steps: [] })).toBe(false);
    expect(isLeadPayload({
      leadChange: { workgroupId: "w", add: [], remove: ["a"], escalation: null, escalates: null },
    })).toBe(true);
    expect(isLeadPayload({})).toBe(false);
  });
});

describe("leadChangeNeedsAdmins", () => {
  it("is true when nobody else can object, including a sole lead proposing a co-lead", () => {
    expect(leadChangeNeedsAdmins(["lead"], ["newbie"], "lead")).toBe(true);
    expect(leadChangeNeedsAdmins(["lead"], ["lead"], "admin")).toBe(true);
    expect(leadChangeNeedsAdmins(["lead", "other"], ["newbie"], "lead")).toBe(false);
  });
});

describe("taskExceedsLazyCap", () => {
  it("escalates ADA above the cap and any other token, never without a cap", () => {
    expect(taskExceedsLazyCap({ ADA: "100" }, "100000000", null)).toBe(false);
    expect(taskExceedsLazyCap({ GVTT: "5" }, null, null)).toBe(false);
    expect(taskExceedsLazyCap({ ADA: "100" }, "100000000", "100000000")).toBe(false);
    expect(taskExceedsLazyCap({ ada: "100.000001" }, "100000001", "100000000")).toBe(true);
    expect(taskExceedsLazyCap({ ADA: "1", GVTT: "5" }, "1000000", "100000000")).toBe(true);
  });
});
