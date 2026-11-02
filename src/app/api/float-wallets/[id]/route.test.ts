import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError, ForbiddenError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  admin: vi.fn(),
  require: vi.fn(),
  archive: vi.fn(),
  restore: vi.fn(),
  update: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireAdmin: mocks.admin }));
vi.mock("@/lib/db/floatWallets", () => ({
  requireFloatWallet: mocks.require,
  archiveFloatWallet: mocks.archive,
  restoreFloatWallet: mocks.restore,
  updateFloatWallet: mocks.update,
}));
import { POST } from "./route";

const ADMIN = "addr_test1admin";
const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const FLOAT_ID = "20000000-0000-4000-8000-000000000002";
const context = { params: Promise.resolve({ id: FLOAT_ID }) };
const request = (value: object) =>
  new Request(`http://localhost/api/float-wallets/${FLOAT_ID}`, {
    method: "POST",
    body: JSON.stringify(value),
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: ADMIN });
  mocks.admin.mockResolvedValue("admin");
  mocks.require.mockResolvedValue({ id: FLOAT_ID, community_id: COMMUNITY });
  mocks.archive.mockResolvedValue(undefined);
  mocks.restore.mockResolvedValue(undefined);
});

describe("POST /api/float-wallets/[id]", () => {
  it("needs a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError("Sign in first"));
    expect((await POST(request({ action: "archive" }), context)).status).toBe(401);
    expect(mocks.archive).not.toHaveBeenCalled();
  });

  it("is admin-only", async () => {
    mocks.admin.mockRejectedValue(new ForbiddenError("Requires admin role"));
    const res = await POST(request({ action: "archive" }), context);
    expect(res.status).toBe(403);
    expect(mocks.admin).toHaveBeenCalledWith(COMMUNITY, ADMIN);
    expect(mocks.archive).not.toHaveBeenCalled();
  });

  it("archives a float wallet", async () => {
    const res = await POST(request({ action: "archive" }), context);
    expect(res.status).toBe(200);
    expect(mocks.archive).toHaveBeenCalledWith(FLOAT_ID, ADMIN);
    expect(mocks.restore).not.toHaveBeenCalled();
  });

  it("restores a float wallet", async () => {
    const res = await POST(request({ action: "restore" }), context);
    expect(res.status).toBe(200);
    expect(mocks.restore).toHaveBeenCalledWith(FLOAT_ID);
    expect(mocks.archive).not.toHaveBeenCalled();
  });

  it("maps the active cap on restore to 409", async () => {
    mocks.restore.mockRejectedValue(new ConflictError("A community can watch at most 5 float wallets"));
    const res = await POST(request({ action: "restore" }), context);
    expect(res.status).toBe(409);
  });
});
