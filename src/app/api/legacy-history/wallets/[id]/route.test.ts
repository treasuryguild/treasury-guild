import { beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  wallet: vi.fn(),
  network: vi.fn(),
  update: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/legacyHistory/access", () => ({
  requireLegacyWalletAdmin: mocks.wallet,
  requireLegacyAddressNetwork: mocks.network,
}));
vi.mock("@/lib/db/legacyHistory", () => ({ updateLegacyWallet: mocks.update, deleteLegacyWallet: mocks.remove }));
import { DELETE, PATCH } from "./route";

const ADMIN = "addr_test1admin";
const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const WALLET_ID = "30000000-0000-4000-8000-000000000001";
const ADDRESS = "addr_test1vqsruvxw9c5kk50ujld079wdajlc3ptjhm20zg8uzn4a3cqpc7km5";
const context = () => ({ params: Promise.resolve({ id: WALLET_ID }) });
const request = (method: "PATCH" | "DELETE", value: object) =>
  new Request(`http://localhost/api/legacy-history/wallets/${WALLET_ID}`, {
    method,
    body: JSON.stringify(value),
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: ADMIN });
  mocks.wallet.mockResolvedValue({ id: WALLET_ID, community_id: COMMUNITY, name: "Old multisig", address: null });
});

describe("PATCH /api/legacy-history/wallets/[id]", () => {
  it("needs a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError("Sign in first"));
    expect((await PATCH(request("PATCH", { name: "New" }), context())).status).toBe(401);
    expect(mocks.wallet).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("is admin-only and 404s on an unknown wallet", async () => {
    mocks.wallet.mockRejectedValueOnce(new ForbiddenError("Requires admin role"));
    expect((await PATCH(request("PATCH", { name: "New", address: ADDRESS }), context())).status).toBe(403);
    mocks.wallet.mockRejectedValueOnce(new NotFoundError("Previous wallet not found"));
    const missing = await PATCH(request("PATCH", { name: "New" }), context());
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Previous wallet not found" });
    expect(mocks.wallet).toHaveBeenCalledWith(WALLET_ID, ADMIN);
    expect(mocks.network).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("renames without touching the address", async () => {
    const res = await PATCH(request("PATCH", { name: "  Treasury 2024 " }), context());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.network).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenCalledWith(WALLET_ID, { name: "Treasury 2024" });
  });

  it("checks a new address against the wallet's community, and clears it with null", async () => {
    await PATCH(request("PATCH", { address: ADDRESS }), context());
    expect(mocks.network).toHaveBeenCalledWith(COMMUNITY, ADDRESS);
    expect(mocks.update).toHaveBeenLastCalledWith(WALLET_ID, { address: ADDRESS });

    mocks.network.mockClear();
    await PATCH(request("PATCH", { address: null }), context());
    expect(mocks.network).not.toHaveBeenCalled();
    expect(mocks.update).toHaveBeenLastCalledWith(WALLET_ID, { address: null });
  });

  it("refuses an address of the other network", async () => {
    mocks.network.mockRejectedValue(new BadRequestError("Use a mainnet address (addr1…)"));
    const res = await PATCH(request("PATCH", { address: ADDRESS }), context());
    expect(res.status).toBe(400);
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("maps a taken name to 409", async () => {
    mocks.update.mockRejectedValue(new ConflictError("This community already has a previous wallet with that name"));
    const res = await PATCH(request("PATCH", { name: "Other wallet" }), context());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ error: "This community already has a previous wallet with that name", conflict: true });
  });

  it.each([
    [{ name: "  " }],
    [{ name: "x".repeat(65) }],
    [{ address: "addr_test1notanaddress" }],
    [{ address: "" }],
  ])("rejects invalid input %j before loading the wallet", async (body) => {
    const res = await PATCH(request("PATCH", body), context());
    expect(res.status).toBe(400);
    expect(mocks.wallet).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

describe("DELETE /api/legacy-history/wallets/[id]", () => {
  it("needs a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError("Sign in first"));
    expect((await DELETE(request("DELETE", { confirmName: "Old multisig" }), context())).status).toBe(401);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("is admin-only and 404s on an unknown wallet", async () => {
    mocks.wallet.mockRejectedValueOnce(new ForbiddenError("Requires admin role"));
    expect((await DELETE(request("DELETE", { confirmName: "Old multisig" }), context())).status).toBe(403);
    mocks.wallet.mockRejectedValueOnce(new NotFoundError("Previous wallet not found"));
    expect((await DELETE(request("DELETE", { confirmName: "Old multisig" }), context())).status).toBe(404);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("removes the wallet once its name is typed exactly", async () => {
    const res = await DELETE(request("DELETE", { confirmName: " Old multisig " }), context());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.wallet).toHaveBeenCalledWith(WALLET_ID, ADMIN);
    expect(mocks.remove).toHaveBeenCalledTimes(1);
    expect(mocks.remove).toHaveBeenCalledWith(WALLET_ID);
  });

  it.each([
    [{ confirmName: "old multisig" }],
    [{ confirmName: "Old" }],
    [{ confirmName: "" }],
    [{}],
    [{ confirmName: "x".repeat(65) }],
  ])("refuses the wrong confirmation %j", async (body) => {
    const res = await DELETE(request("DELETE", body), context());
    expect(res.status).toBe(400);
    expect(await res.json()).toHaveProperty("error");
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});
