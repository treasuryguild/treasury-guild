import { describe, expect, it } from "vitest";
import { actsForTreasury, isAdminRole, isOwnerRole, managesWorkgroup, mayPropose, mayRecover } from "./roles";

describe("roles", () => {
  it("treats owner and admin as admins", () => {
    expect(isAdminRole("owner")).toBe(true);
    expect(isAdminRole("admin")).toBe(true);
    expect(isAdminRole("member")).toBe(false);
    expect(isAdminRole(null)).toBe(false);
    expect(isAdminRole(undefined)).toBe(false);
  });

  it("only owner is owner", () => {
    expect(isOwnerRole("owner")).toBe(true);
    expect(isOwnerRole("admin")).toBe(false);
  });
  it("lets admins manage workgroups, and treasury actors only the wallets they sign", () => {
    const lead = { isAdmin: false, ledWorkgroupIds: new Set(["wg1"]), signerTreasuryIds: new Set(["t1"]) };
    expect(managesWorkgroup(lead, "wg1")).toBe(true);
    expect(managesWorkgroup(lead, "wg2")).toBe(false);
    expect(actsForTreasury(lead, "t1")).toBe(true);
    expect(actsForTreasury(lead, "t2")).toBe(false);
    const admin = { isAdmin: true, ledWorkgroupIds: new Set<string>(), signerTreasuryIds: new Set<string>() };
    expect(managesWorkgroup(admin, "wg2")).toBe(true);
    expect(actsForTreasury(admin, "t2")).toBe(false);
  });
  it("lets only a treasury's recovery signers build its recovery spend", () => {
    const recovery = { recoveryTreasuryIds: new Set(["t1"]) };
    expect(mayRecover(recovery, "t1")).toBe(true);
    expect(mayRecover(recovery, "t2")).toBe(false);
    expect(mayRecover({ recoveryTreasuryIds: new Set<string>() }, "t2")).toBe(false);
  });
  it("mirrors who may make a proposal", () => {
    const lead = { isAdmin: false, ledWorkgroupIds: new Set(["wg1"]) };
    expect(mayPropose(lead, "members", [])).toBe(true);
    expect(mayPropose(lead, "managers", ["wg1"])).toBe(true);
    expect(mayPropose(lead, "managers", ["wg1", "wg2"])).toBe(false);
    expect(mayPropose(lead, "managers", [])).toBe(false);
    expect(mayPropose(lead, "admins", ["wg1"])).toBe(false);
    expect(mayPropose({ ...lead, isAdmin: true }, "admins", [])).toBe(true);
  });
});
