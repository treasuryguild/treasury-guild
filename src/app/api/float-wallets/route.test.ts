import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError, ForbiddenError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  admin: vi.fn(),
  community: vi.fn(),
  create: vi.fn(),
  tag: vi.fn(),
  classify: vi.fn(),
  rate: vi.fn(),
  txInfo: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireAdmin: mocks.admin }));
vi.mock("@/lib/db/communities", () => ({ requireCommunity: mocks.community }));
vi.mock("@/lib/db/floatWallets", () => ({
  createFloatWallet: mocks.create,
  tagFloatTransfers: mocks.tag,
  classifyPoolRewardInflows: mocks.classify,
}));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.rate }));
vi.mock("@/lib/cardano/koios", () => ({ txInfoBulk: mocks.txInfo }));
import { POST } from "./route";

const ADMIN = "addr_test1admin";
const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const ADDRESS = "addr_test1vqsruvxw9c5kk50ujld079wdajlc3ptjhm20zg8uzn4a3cqpc7km5";
const AFTER_TX = "a".repeat(64);
const context = { params: Promise.resolve({}) };
const request = (value: object) =>
  new Request("http://localhost/api/float-wallets", {
    method: "POST",
    body: JSON.stringify(value),
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: ADMIN });
  mocks.admin.mockResolvedValue("admin");
  mocks.community.mockResolvedValue({ id: COMMUNITY, network: 0 });
  mocks.create.mockResolvedValue({ id: "float-new" });
  mocks.tag.mockResolvedValue(undefined);
  mocks.classify.mockResolvedValue(undefined);
  mocks.rate.mockResolvedValue(undefined);
  mocks.txInfo.mockResolvedValue([]);
});

describe("POST /api/float-wallets", () => {
  it("needs a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError("Sign in first"));
    expect((await POST(request({ communityId: COMMUNITY, name: "DEX", address: ADDRESS }), context)).status).toBe(401);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("is admin-only", async () => {
    mocks.admin.mockRejectedValue(new ForbiddenError("Requires admin role"));
    const res = await POST(request({ communityId: COMMUNITY, name: "DEX", address: ADDRESS }), context);
    expect(res.status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("creates a float wallet on the community network and retags transfers", async () => {
    const res = await POST(request({
      communityId: COMMUNITY, name: "  DEX float ", address: ADDRESS, note: " Alice holds key ",
    }), context);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "float-new" });
    expect(mocks.rate).toHaveBeenCalledWith("floatWalletCreate", ADMIN);
    expect(mocks.txInfo).not.toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalledWith({
      community_id: COMMUNITY,
      name: "DEX float",
      address: ADDRESS,
      note: "Alice holds key",
      purpose: "dex",
      created_by: ADMIN,
      sync_from_tx_hash: null,
      sync_from_block: null,
    });
    expect(mocks.tag).toHaveBeenCalledWith(COMMUNITY);
    expect(mocks.classify).toHaveBeenCalledWith(COMMUNITY);
  });

  it("creates a pool_rewards float when purpose is set", async () => {
    const res = await POST(request({
      communityId: COMMUNITY, name: "Rewards buffer", address: ADDRESS, purpose: "pool_rewards",
    }), context);
    expect(res.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({ purpose: "pool_rewards" }));
  });

  it("seeds sync-from when afterTxHash involves the float address", async () => {
    mocks.txInfo.mockResolvedValue([{
      tx_hash: AFTER_TX,
      block_height: 42_000,
      tx_timestamp: 1,
      inputs: [{ payment_addr: { bech32: ADDRESS }, value: "1" }],
      outputs: [{ payment_addr: { bech32: "addr_test1other" }, value: "1" }],
    }]);
    const res = await POST(request({
      communityId: COMMUNITY, name: "DEX", address: ADDRESS, afterTxHash: AFTER_TX,
    }), context);
    expect(res.status).toBe(200);
    expect(mocks.txInfo).toHaveBeenCalledWith(0, [AFTER_TX]);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      sync_from_tx_hash: AFTER_TX,
      sync_from_block: 42_000,
    }));
  });

  it("refuses an afterTxHash that does not involve the address", async () => {
    mocks.txInfo.mockResolvedValue([{
      tx_hash: AFTER_TX,
      block_height: 42_000,
      tx_timestamp: 1,
      inputs: [{ payment_addr: { bech32: "addr_test1other" }, value: "1" }],
      outputs: [{ payment_addr: { bech32: "addr_test1else" }, value: "1" }],
    }]);
    const res = await POST(request({
      communityId: COMMUNITY, name: "DEX", address: ADDRESS, afterTxHash: AFTER_TX,
    }), context);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "That transaction does not involve this float address" });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("refuses an unknown afterTxHash", async () => {
    mocks.txInfo.mockResolvedValue([]);
    const res = await POST(request({
      communityId: COMMUNITY, name: "DEX", address: ADDRESS, afterTxHash: AFTER_TX,
    }), context);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "That transaction was not found on this network" });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("refuses a mainnet address on a preprod community", async () => {
    const mainnet =
      "addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x";
    const res = await POST(request({
      communityId: COMMUNITY,
      name: "DEX",
      address: mainnet,
    }), context);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Use a preprod address (addr_test1…)" });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("maps a taken address to 409", async () => {
    mocks.create.mockRejectedValue(new ConflictError("This community already watches that address"));
    const res = await POST(request({ communityId: COMMUNITY, name: "DEX", address: ADDRESS }), context);
    expect(res.status).toBe(409);
  });

  it("maps the active cap to 409", async () => {
    mocks.create.mockRejectedValue(new ConflictError("A community can watch at most 5 float wallets"));
    const res = await POST(request({ communityId: COMMUNITY, name: "DEX", address: ADDRESS }), context);
    expect(res.status).toBe(409);
  });
});
