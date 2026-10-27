import { describe, expect, it, vi } from "vitest";

vi.mock("./db/client", () => ({ maybe: vi.fn(), rows: vi.fn(), serviceClient: vi.fn() }));
vi.mock("./db/treasuries", () => ({ loadTreasury: vi.fn() }));
vi.mock("./db/workgroups", () => ({ requireWorkgroupCommunity: vi.fn() }));

import { isTreasuryActor, requireTreasuryActor } from "./authz";
import { Role } from "./constants";
import { ForbiddenError } from "./errors";

describe("isTreasuryActor", () => {
  it("goes by the signer flag alone — community admin is not enough", () => {
    expect(isTreasuryActor(Role.Owner, false)).toBe(false);
    expect(isTreasuryActor(Role.Admin, false)).toBe(false);
    expect(isTreasuryActor(Role.Owner, true)).toBe(true);
    expect(isTreasuryActor(Role.Admin, true)).toBe(true);
    expect(isTreasuryActor(Role.Member, true)).toBe(true);
    expect(isTreasuryActor(Role.Member, false)).toBe(false);
    expect(isTreasuryActor(null, true)).toBe(true);
    expect(isTreasuryActor(null, false)).toBe(false);
  });
});

describe("requireTreasuryActor", () => {
  it("passes only signers", () => {
    expect(() => requireTreasuryActor(Role.Admin, false, "no")).toThrow(ForbiddenError);
    expect(() => requireTreasuryActor(Role.Member, true, "no")).not.toThrow();
  });

  it("refuses everyone else with the caller's message", () => {
    expect(() => requireTreasuryActor(Role.Member, false, "Only treasury signers can build payments")).toThrow(ForbiddenError);
    expect(() => requireTreasuryActor(Role.Member, false, "Only treasury signers can build payments")).toThrow(
      "Only treasury signers can build payments",
    );
  });
});
