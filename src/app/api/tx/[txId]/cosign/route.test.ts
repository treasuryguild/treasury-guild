import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as AuthzModule from "@/lib/authz";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), context: vi.fn(), role: vi.fn(), cosign: vi.fn(), pending: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session, requireSession: mocks.session }));
vi.mock("@/lib/tx", () => ({ loadTxContext: mocks.context }));
vi.mock("@/lib/authz", async (importOriginal) => ({
  ...(await importOriginal<typeof AuthzModule>()),
  memberRole: mocks.role,
}));
vi.mock("@/lib/cosigner/sign", () => ({ cosignWithAppKey: mocks.cosign }));
vi.mock("@/lib/db/transactions", () => ({ loadPendingTransactions: mocks.pending }));

import { POST } from "./route";

const WALLET = "addr_test1signer";
const TX = "40000000-0000-4000-8000-000000000001";
const TREASURY = "40000000-0000-4000-8000-000000000002";
const post = (headers: Record<string, string> = {}) =>
  POST(new Request(`http://localhost/api/tx/${TX}/cosign`, { method: "POST", headers }), { params: Promise.resolve({ txId: TX }) });

const tx = { id: TX, treasury_id: TREASURY, signed_addresses: [WALLET] };
const treasury = { id: TREASURY, community_id: "community", cosigner_kind: "app" };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.context.mockResolvedValue({ tx, treasury, signers: [], callerSigner: { wallet_address: WALLET, signer_group: "base" } });
  mocks.role.mockResolvedValue("member");
  mocks.cosign.mockResolvedValue({ signed: true, check: { passed: true, problems: [] } });
  mocks.pending.mockResolvedValue([{ id: TX, signed_addresses: [WALLET, "addr_test1cosigner"] }]);
});

describe("POST /api/tx/[txId]/cosign", () => {
  it("requires a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await post()).status).toBe(401);
    expect(mocks.cosign).not.toHaveBeenCalled();
  });

  it("refuses a cross-site request", async () => {
    expect((await post({ origin: "https://evil.test" })).status).toBe(403);
    expect(mocks.cosign).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown transaction", async () => {
    mocks.context.mockRejectedValue(new NotFoundError("Transaction not found"));
    expect((await post()).status).toBe(404);
    expect(mocks.cosign).not.toHaveBeenCalled();
  });

  it("passes the member check on to the caller", async () => {
    mocks.context.mockRejectedValue(new ForbiddenError("Not a community member"));
    expect((await post()).status).toBe(403);
  });

  it("refuses a caller who is not a base signer", async () => {
    mocks.context.mockResolvedValue({ tx, treasury, signers: [], callerSigner: { wallet_address: WALLET, signer_group: "recovery" } });
    const res = await post();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/co-signer to check again/);
    expect(mocks.cosign).not.toHaveBeenCalled();
  });

  it("refuses an admin who signs nothing", async () => {
    mocks.context.mockResolvedValue({ tx, treasury, signers: [], callerSigner: null });
    mocks.role.mockResolvedValue("admin");
    const res = await post();
    expect(res.status).toBe(403);
    expect((await res.json()).error).toMatch(/Only treasury signers/);
    expect(mocks.cosign).not.toHaveBeenCalled();
  });

  it("answers 400 when the co-signer is a member, who signs on the page", async () => {
    mocks.context.mockResolvedValue({ tx, treasury: { ...treasury, cosigner_kind: "member" }, signers: [], callerSigner: { wallet_address: WALLET, signer_group: "base" } });
    const res = await post();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/co-signer is a member/);
    expect(mocks.cosign).not.toHaveBeenCalled();
  });

  it("runs the check as a manual trigger and reports who has signed since", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      signed: true, passed: true, problems: [], signedAddresses: [WALLET, "addr_test1cosigner"],
    });
    expect(mocks.cosign).toHaveBeenCalledWith(TX, "manual");
    expect(mocks.pending).toHaveBeenCalledWith([TREASURY]);
  });

  it("falls back to the row it loaded when the transaction is no longer the pending one", async () => {
    mocks.cosign.mockResolvedValue({ signed: false, check: { passed: false, problems: ["Budget for 2026-08 is over"] } });
    mocks.pending.mockResolvedValue([]);
    const res = await post();
    expect(await res.json()).toEqual({
      signed: false, passed: false, problems: ["Budget for 2026-08 is over"], signedAddresses: [WALLET],
    });
  });
});
