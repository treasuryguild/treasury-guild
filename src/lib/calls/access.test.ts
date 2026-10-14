import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ manager: vi.fn(), loadCall: vi.fn(), assertActive: vi.fn() }));
vi.mock("@/lib/authz", () => ({ requireWorkgroupManager: mocks.manager }));
vi.mock("@/lib/db/calls", () => ({ loadCall: mocks.loadCall }));
vi.mock("@/lib/db/workgroups", () => ({ assertWorkgroupActive: mocks.assertActive }));

import type { CallWithWorkgroup } from "@/lib/db/calls";
import { BadRequestError, NotFoundError } from "@/lib/errors";
import { assertWalletOnCallNetwork, loadCallForManager, requireWorkgroupManager } from "./access";

const PREPROD =
  "addr_test1qp86rhgehcs4k99rpu48879jncjmeytlhv4nxfd3sw2def6xxu4ylafkwgp2ad5l74sa3s75ttr3enxg2ps2qtrpanyswgshl2";
const MAINNET =
  "addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x";

const call = (workgroups: CallWithWorkgroup["workgroups"]): CallWithWorkgroup =>
  ({ id: "call-1", community_id: "com-1", workgroup_id: "wg-1", workgroups }) as CallWithWorkgroup;
const onNetwork = (network: number) => call({ archived_at: null, communities: { slug: "signius", network } });

beforeEach(() => {
  vi.resetAllMocks();
});

describe("assertWalletOnCallNetwork", () => {
  it("accepts a wallet on the community's network", () => {
    expect(() => assertWalletOnCallNetwork(onNetwork(0), PREPROD)).not.toThrow();
    expect(() => assertWalletOnCallNetwork(onNetwork(1), MAINNET)).not.toThrow();
  });

  it("refuses a preprod address in a mainnet community", () => {
    expect(() => assertWalletOnCallNetwork(onNetwork(1), PREPROD)).toThrow(BadRequestError);
    expect(() => assertWalletOnCallNetwork(onNetwork(1), PREPROD)).toThrow(
      "This community pays on mainnet: use a mainnet address",
    );
  });

  it("refuses a mainnet address in a preprod community", () => {
    expect(() => assertWalletOnCallNetwork(onNetwork(0), MAINNET)).toThrow(BadRequestError);
    expect(() => assertWalletOnCallNetwork(onNetwork(0), MAINNET)).toThrow(
      "This community pays on preprod: use a preprod (addr_test…) address",
    );
  });

  it("checks nothing when the call carries no community network", () => {
    expect(() => assertWalletOnCallNetwork(call(null), MAINNET)).not.toThrow();
    expect(() => assertWalletOnCallNetwork(call({ archived_at: null, communities: null }), PREPROD)).not.toThrow();
  });
});

describe("requireWorkgroupManager", () => {
  it("delegates with the calls wording", async () => {
    mocks.manager.mockResolvedValue(undefined);
    await requireWorkgroupManager("com-1", "wg-1", "addr_w");
    expect(mocks.manager).toHaveBeenCalledWith("com-1", "wg-1", "addr_w", "Only admins and workgroup leads can manage calls");
  });
});

describe("loadCallForManager", () => {
  it("is a 404 for a call that does not exist, before any authorization", async () => {
    mocks.loadCall.mockResolvedValue(null);
    await expect(loadCallForManager("call-x", "addr_w")).rejects.toThrow(NotFoundError);
    expect(mocks.manager).not.toHaveBeenCalled();
  });

  it("authorizes against the call's own community and workgroup, then checks the workgroup is active", async () => {
    const found = call({ archived_at: "2026-09-01T00:00:00Z", communities: { slug: "signius", network: 0 } });
    mocks.loadCall.mockResolvedValue(found);
    mocks.manager.mockResolvedValue(undefined);
    expect(await loadCallForManager("call-1", "addr_w")).toBe(found);
    expect(mocks.manager).toHaveBeenCalledWith("com-1", "wg-1", "addr_w", "Only admins and workgroup leads can manage calls");
    expect(mocks.assertActive).toHaveBeenCalledWith("2026-09-01T00:00:00Z");
  });

  it("does not reach the archive check when the caller is not a manager", async () => {
    mocks.loadCall.mockResolvedValue(onNetwork(0));
    mocks.manager.mockRejectedValue(new Error("Only admins and workgroup leads can manage calls"));
    await expect(loadCallForManager("call-1", "addr_w")).rejects.toThrow("manage calls");
    expect(mocks.assertActive).not.toHaveBeenCalled();
  });
});
