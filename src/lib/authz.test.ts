import { describe, expect, it, vi } from "vitest";

vi.mock("./db/client", () => ({ maybe: vi.fn(), rows: vi.fn(), serviceClient: vi.fn() }));
vi.mock("./db/treasuries", () => ({ loadTreasury: vi.fn() }));
vi.mock("./db/workgroups", () => ({ requireWorkgroupCommunity: vi.fn() }));

import { isTreasuryActor, requireTreasuryActor } from "./authz";
import { Role } from "./constants";
import { ForbiddenError } from "./errors";

describe("isTreasuryActor", () => {
  it("lets owners and admins act, signer or not", () => {
    expect(isTreasuryActor(Role.Owner, false)).toBe(true);
    expect(isTreasuryActor(Role.Admin, false)).toBe(true);
    expect(isTreasuryActor(Role.Owner, true)).toBe(true);
    expect(isTreasuryActor(Role.Admin, true)).toBe(true);
  });

  it("lets a plain member act only as a signer", () => {
    expect(isTreasuryActor(Role.Member, true)).toBe(true);
    expect(isTreasuryActor(Role.Member, false)).toBe(false);
  });

  it("goes by the signer flag alone when there is no role", () => {
    expect(isTreasuryActor(null, true)).toBe(true);
    expect(isTreasuryActor(null, false)).toBe(false);
  });

  it("does not take an unknown or differently cased role for an admin", () => {
    expect(isTreasuryActor("Admin", false)).toBe(false);
    expect(isTreasuryActor("lead", false)).toBe(false);
    expect(isTreasuryActor("", false)).toBe(false);
  });
});

describe("requireTreasuryActor", () => {
  it("passes admins and signers", () => {
    expect(() => requireTreasuryActor(Role.Admin, false, "no")).not.toThrow();
    expect(() => requireTreasuryActor(Role.Member, true, "no")).not.toThrow();
  });

  it("refuses everyone else with the caller's message", () => {
    expect(() => requireTreasuryActor(Role.Member, false, "Only admins and signers can build payments")).toThrow(ForbiddenError);
    expect(() => requireTreasuryActor(Role.Member, false, "Only admins and signers can build payments")).toThrow(
      "Only admins and signers can build payments",
    );
  });
});
