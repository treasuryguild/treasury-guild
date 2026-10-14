import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  payment: vi.fn(),
  remove: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/legacyHistory/access", () => ({ requireLegacyPaymentAdmin: mocks.payment }));
vi.mock("@/lib/db/legacyHistory", () => ({ deleteLegacyPayment: mocks.remove }));
import { DELETE } from "./route";

const ADMIN = "addr_test1admin";
const PAYMENT_ID = "60000000-0000-4000-8000-000000000001";
const IMPORT_ID = "40000000-0000-4000-8000-000000000001";
const context = () => ({ params: Promise.resolve({ id: PAYMENT_ID }) });
const request = () => new Request(`http://localhost/api/legacy-history/rows/${PAYMENT_ID}`, { method: "DELETE" });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: ADMIN });
  mocks.payment.mockResolvedValue({ id: PAYMENT_ID, import_id: IMPORT_ID, community_id: "com" });
});

describe("DELETE /api/legacy-history/rows/[id]", () => {
  it("needs a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError("Sign in first"));
    expect((await DELETE(request(), context())).status).toBe(401);
    expect(mocks.payment).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("is admin-only", async () => {
    mocks.payment.mockRejectedValue(new ForbiddenError("Requires admin role"));
    expect((await DELETE(request(), context())).status).toBe(403);
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("404s on an unknown line", async () => {
    mocks.payment.mockRejectedValue(new NotFoundError("History line not found"));
    const res = await DELETE(request(), context());
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ error: "History line not found" });
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("removes the line with its import id, so an emptied import can go too", async () => {
    const res = await DELETE(request(), context());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.payment).toHaveBeenCalledWith(PAYMENT_ID, ADMIN);
    expect(mocks.remove).toHaveBeenCalledTimes(1);
    expect(mocks.remove).toHaveBeenCalledWith(PAYMENT_ID, IMPORT_ID);
  });
});
