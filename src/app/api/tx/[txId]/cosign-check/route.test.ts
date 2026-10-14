import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({ session: vi.fn(), context: vi.fn(), check: vi.fn(), decisions: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session, requireSession: mocks.session }));
vi.mock("@/lib/tx", () => ({ loadTxContext: mocks.context }));
vi.mock("@/lib/cosigner/check", () => ({ runCosignerCheck: mocks.check }));
vi.mock("@/lib/db/cosigner", () => ({ loadCosignerDecisions: mocks.decisions }));

import { GET } from "./route";

const TX = "40000000-0000-4000-8000-000000000001";
const get = () => GET(new Request(`http://localhost/api/tx/${TX}/cosign-check`), { params: Promise.resolve({ txId: TX }) });

const tx = { id: TX, treasury_id: "treasury", spending_path: "cosigned" };
const treasury = { id: "treasury", community_id: "community", cosigner_kind: "app" };
const decision = { id: "d1", transaction_id: TX, decided_at: "2026-10-01T00:00:00.000Z", trigger: "sign", passed: false, problems: ["x"], signed: false };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: "addr_test1member" });
  mocks.context.mockResolvedValue({ tx, treasury, signers: [], callerSigner: null });
  mocks.check.mockResolvedValue({ passed: false, problems: ["Output 0 differs from the stored payment"] });
  mocks.decisions.mockResolvedValue([decision]);
});

describe("GET /api/tx/[txId]/cosign-check", () => {
  it("requires a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await get()).status).toBe(401);
    expect(mocks.check).not.toHaveBeenCalled();
  });

  it("answers 404 for an unknown transaction and 403 for a non-member", async () => {
    mocks.context.mockRejectedValueOnce(new NotFoundError("Transaction not found"));
    expect((await get()).status).toBe(404);
    mocks.context.mockRejectedValueOnce(new ForbiddenError("Not a community member"));
    expect((await get()).status).toBe(403);
    expect(mocks.check).not.toHaveBeenCalled();
  });

  it("answers 400 for a transaction that is not on the co-signed path", async () => {
    mocks.context.mockResolvedValue({ tx: { ...tx, spending_path: "bypass" }, treasury, signers: [], callerSigner: null });
    const res = await get();
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatch(/co-signed transaction/);
    expect(mocks.check).not.toHaveBeenCalled();
  });

  it("runs the check now and lists the recorded decisions for any member", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      passed: false, problems: ["Output 0 differs from the stored payment"], decisions: [decision],
    });
    expect(mocks.check).toHaveBeenCalledWith(tx, treasury);
    expect(mocks.decisions).toHaveBeenCalledWith(TX);
  });
});
