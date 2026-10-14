import { beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestError, ConflictError, ForbiddenError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  admin: vi.fn(),
  network: vi.fn(),
  create: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireAdmin: mocks.admin }));
vi.mock("@/lib/legacyHistory/access", () => ({ requireLegacyAddressNetwork: mocks.network }));
vi.mock("@/lib/db/legacyHistory", () => ({ createLegacyWallet: mocks.create }));
import { POST } from "./route";

const ADMIN = "addr_test1admin";
const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const ADDRESS = "addr_test1vqsruvxw9c5kk50ujld079wdajlc3ptjhm20zg8uzn4a3cqpc7km5";
const context = { params: Promise.resolve({}) };
const request = (value: object) =>
  new Request("http://localhost/api/legacy-history/wallets", {
    method: "POST",
    body: JSON.stringify(value),
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: ADMIN });
  mocks.admin.mockResolvedValue("admin");
  mocks.create.mockResolvedValue({ id: "wallet-new" });
});

describe("POST /api/legacy-history/wallets", () => {
  it("needs a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError("Sign in first"));
    expect((await POST(request({ communityId: COMMUNITY, name: "Old multisig" }), context)).status).toBe(401);
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("is admin-only, checked before the address", async () => {
    mocks.admin.mockRejectedValue(new ForbiddenError("Requires admin role"));
    const res = await POST(request({ communityId: COMMUNITY, name: "Old multisig", address: ADDRESS }), context);
    expect(res.status).toBe(403);
    expect(mocks.admin).toHaveBeenCalledWith(COMMUNITY, ADMIN);
    expect(mocks.network).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("creates a wallet without an address", async () => {
    const res = await POST(request({ communityId: COMMUNITY, name: "  Old multisig " }), context);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "wallet-new" });
    expect(mocks.network).not.toHaveBeenCalled();
    expect(mocks.create).toHaveBeenCalledTimes(1);
    expect(mocks.create).toHaveBeenCalledWith({
      community_id: COMMUNITY, name: "Old multisig", address: null, created_by: ADMIN,
    });
  });

  it("checks an address against the community's network, then stores it", async () => {
    const res = await POST(request({ communityId: COMMUNITY, name: "Old multisig", address: ADDRESS }), context);
    expect(res.status).toBe(200);
    expect(mocks.network).toHaveBeenCalledWith(COMMUNITY, ADDRESS);
    expect(mocks.create).toHaveBeenCalledWith({
      community_id: COMMUNITY, name: "Old multisig", address: ADDRESS, created_by: ADMIN,
    });
  });

  it("refuses an address of the other network", async () => {
    mocks.network.mockRejectedValue(new BadRequestError("Use a mainnet address (addr1…)"));
    const res = await POST(request({ communityId: COMMUNITY, name: "Old multisig", address: ADDRESS }), context);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Use a mainnet address (addr1…)" });
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("maps a taken name to 409", async () => {
    mocks.create.mockRejectedValue(new ConflictError("This community already has a previous wallet with that name"));
    const res = await POST(request({ communityId: COMMUNITY, name: "Old multisig" }), context);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "This community already has a previous wallet with that name", conflict: true });
  });

  it.each([
    [{}],
    [{ communityId: "nope", name: "X" }],
    [{ communityId: COMMUNITY }],
    [{ communityId: COMMUNITY, name: "  " }],
    [{ communityId: COMMUNITY, name: "x".repeat(65) }],
    [{ communityId: COMMUNITY, name: "X", address: "addr_test1notanaddress" }],
    [{ communityId: COMMUNITY, name: "X", address: "" }],
  ])("rejects invalid input %j before any authorization", async (body) => {
    const res = await POST(request(body), context);
    expect(res.status).toBe(400);
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
