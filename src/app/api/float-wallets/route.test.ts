import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError, ForbiddenError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  admin: vi.fn(),
  community: vi.fn(),
  create: vi.fn(),
  tag: vi.fn(),
  rate: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireAdmin: mocks.admin }));
vi.mock("@/lib/db/communities", () => ({ requireCommunity: mocks.community }));
vi.mock("@/lib/db/floatWallets", () => ({
  createFloatWallet: mocks.create,
  tagFloatTransfers: mocks.tag,
}));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.rate }));
import { POST } from "./route";

const ADMIN = "addr_test1admin";
const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const ADDRESS = "addr_test1vqsruvxw9c5kk50ujld079wdajlc3ptjhm20zg8uzn4a3cqpc7km5";
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
  mocks.rate.mockResolvedValue(undefined);
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
    expect(mocks.create).toHaveBeenCalledWith({
      community_id: COMMUNITY,
      name: "DEX float",
      address: ADDRESS,
      note: "Alice holds key",
      created_by: ADMIN,
    });
    expect(mocks.tag).toHaveBeenCalledWith(COMMUNITY);
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
