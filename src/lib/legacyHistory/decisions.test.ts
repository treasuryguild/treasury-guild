import { describe, expect, it } from "vitest";
import { applyWorkgroupDecisions, pendingWorkgroupId } from "./decisions";
import type { LegacyWorkgroup } from "./types";

const OPS: LegacyWorkgroup = { id: "wg-ops", name: "Ops", archived: false };

describe("applyWorkgroupDecisions", () => {
  it("stands in for a workgroup a create would add", () => {
    const applied = applyWorkgroupDecisions([], new Map(), [{ ref: "Ops Team", action: "create" }], false);
    expect(applied.questions).toEqual([]);
    expect(applied.applied).toEqual([{ ref: "ops-team", action: "create", displayName: "Ops Team" }]);
    expect(applied.workgroups).toEqual([{ id: pendingWorkgroupId("ops-team"), name: "Ops Team", archived: false }]);
    expect(applied.aliases.get("ops-team")).toBe(pendingWorkgroupId("ops-team"));
  });

  it("refuses a create while workgroup proposals are on", () => {
    const applied = applyWorkgroupDecisions([], new Map(), [{ ref: "ops", action: "create", displayName: "Ops" }], true);
    expect(applied.applied).toEqual([]);
    expect(applied.workgroups).toEqual([]);
    expect(applied.questions[0]!.message).toMatch(/proposals are on/);
  });

  it("maps a name onto an existing workgroup and drops a choice the name already has", () => {
    const mapped = applyWorkgroupDecisions([OPS], new Map(), [{ ref: "operations", action: "map", workgroupId: OPS.id }], false);
    expect(mapped.questions).toEqual([]);
    expect(mapped.aliases.get("operations")).toBe(OPS.id);

    const same = applyWorkgroupDecisions([OPS], new Map(), [{ ref: "Ops", action: "create" }], false);
    expect(same.applied).toEqual([]);
    expect(same.questions).toEqual([]);
  });

  it("asks when a create's name is taken or a map points outside the community", () => {
    const taken = applyWorkgroupDecisions([OPS], new Map(), [{ ref: "other", action: "create", displayName: "Ops" }], false);
    expect(taken.applied).toEqual([]);
    expect(taken.questions[0]!.message).toMatch(/already exists/);

    const missing = applyWorkgroupDecisions([OPS], new Map(), [{ ref: "other", action: "map", workgroupId: "nope" }], false);
    expect(missing.applied).toEqual([]);
    expect(missing.questions[0]!.message).toMatch(/No workgroup/);
  });
});
