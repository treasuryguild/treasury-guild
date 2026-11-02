import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError, ForbiddenError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  admin: vi.fn(),
  community: vi.fn(),
  create: vi.fn(),
  rate: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireAdmin: mocks.admin }));
vi.mock("@/lib/db/conversions", () => ({
  communityIdForInflow: mocks.community,
  createConversion: mocks.create,
}));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.rate }));
import { POST } from "./route";

const ADMIN = "addr_test1admin";
const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const TX = "a".repeat(64);
const context = { params: Promise.resolve({}) };
const request = (value: object) =>
  new Request("http://localhost/api/conversions", {
    method: "POST",
    body: JSON.stringify(value),
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: ADMIN });
  mocks.admin.mockResolvedValue("admin");
  mocks.community.mockResolvedValue(COMMUNITY);
  mocks.create.mockResolvedValue({ id: "conv-1" });
  mocks.rate.mockResolvedValue(undefined);
});

describe("POST /api/conversions", () => {
  it("needs a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError("Sign in first"));
    expect((await POST(request({
      kind: "bridge", incomingTxHash: TX, sentAmount: "10", sentAssetLabel: "FET", sentChain: "ethereum",
    }), context)).status).toBe(401);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("is admin-only", async () => {
    mocks.admin.mockRejectedValue(new ForbiddenError("Requires admin role"));
    const res = await POST(request({
      kind: "bridge", incomingTxHash: TX, sentAmount: "10", sentAssetLabel: "FET", sentChain: "ethereum",
    }), context);
    expect(res.status).toBe(403);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("creates a treasury-attached conversion", async () => {
    const res = await POST(request({
      kind: "bridge",
      incomingTxHash: TX,
      sentAmount: "100",
      sentAssetLabel: "FET",
      sentChain: "ethereum",
      fees: [{ kind: "gas", amount: "0.002", assetLabel: "ETH", chain: "ethereum" }],
      proofs: [{ chain: "ethereum", txHash: "0xabc", label: "Eth send" }],
    }), context);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "conv-1" });
    expect(mocks.rate).toHaveBeenCalledWith("conversionWrite", ADMIN);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      community_id: COMMUNITY,
      kind: "bridge",
      incoming_tx_hash: TX,
      float_incoming_tx_hash: null,
      sent_amount: "100",
      fees: [{ kind: "gas", amount: "0.002", asset_label: "ETH", chain: "ethereum" }],
      proofs: [{ chain: "ethereum", tx_hash: "0xabc", url: null, label: "Eth send" }],
    }));
  });

  it("creates a float-attached conversion", async () => {
    const res = await POST(request({
      kind: "swap",
      floatIncomingTxHash: TX,
      sentAmount: "50",
      sentAssetLabel: "FET",
      sentChain: "cardano",
    }), context);
    expect(res.status).toBe(200);
    expect(mocks.community).toHaveBeenCalledWith({
      incomingTxHash: undefined,
      floatIncomingTxHash: TX,
    });
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      float_incoming_tx_hash: TX,
      incoming_tx_hash: null,
      kind: "swap",
    }));
  });

  it("refuses attaching to both inflows", async () => {
    const res = await POST(request({
      kind: "bridge",
      incomingTxHash: TX,
      floatIncomingTxHash: "b".repeat(64),
      sentAmount: "1",
      sentAssetLabel: "ADA",
      sentChain: "cardano",
    }), context);
    expect(res.status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("maps a duplicate attach to 409", async () => {
    mocks.create.mockRejectedValue(new ConflictError("This inflow already has a conversion record"));
    const res = await POST(request({
      kind: "bridge", incomingTxHash: TX, sentAmount: "10", sentAssetLabel: "FET", sentChain: "ethereum",
    }), context);
    expect(res.status).toBe(409);
  });
});
