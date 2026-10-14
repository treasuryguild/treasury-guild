import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  admin: vi.fn(),
  rows: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireAdmin: mocks.admin }));
vi.mock("@/lib/db/legacyHistory", () => ({ loadLegacyRows: mocks.rows }));
import { GET } from "./route";

const ADMIN = "addr_test1admin";
const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const WALLET_ID = "30000000-0000-4000-8000-000000000001";
const IMPORT_ID = "40000000-0000-4000-8000-000000000001";
const PAGE = { rows: [{ id: "p1" }], total: 1 };
const context = { params: Promise.resolve({}) };
const request = (query: string) => new Request(`http://localhost/api/legacy-history/rows?${query}`);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: ADMIN });
  mocks.admin.mockResolvedValue("admin");
  mocks.rows.mockResolvedValue(PAGE);
});

describe("GET /api/legacy-history/rows", () => {
  it("needs a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError("Sign in first"));
    expect((await GET(request(`communityId=${COMMUNITY}`), context)).status).toBe(401);
    expect(mocks.rows).not.toHaveBeenCalled();
  });

  it("is admin-only", async () => {
    mocks.admin.mockRejectedValue(new ForbiddenError("Requires admin role"));
    expect((await GET(request(`communityId=${COMMUNITY}`), context)).status).toBe(403);
    expect(mocks.admin).toHaveBeenCalledWith(COMMUNITY, ADMIN);
    expect(mocks.rows).not.toHaveBeenCalled();
  });

  it("reads the first page of the community by default", async () => {
    const res = await GET(request(`communityId=${COMMUNITY}`), context);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(PAGE);
    expect(mocks.rows).toHaveBeenCalledTimes(1);
    expect(mocks.rows).toHaveBeenCalledWith(COMMUNITY, { importId: undefined, walletId: undefined, offset: 0 });
  });

  it("passes the import, wallet and numeric offset on, always scoped to the community", async () => {
    await GET(request(`communityId=${COMMUNITY}&importId=${IMPORT_ID}&offset=200`), context);
    expect(mocks.rows).toHaveBeenLastCalledWith(COMMUNITY, { importId: IMPORT_ID, walletId: undefined, offset: 200 });
    await GET(request(`communityId=${COMMUNITY}&walletId=${WALLET_ID}`), context);
    expect(mocks.rows).toHaveBeenLastCalledWith(COMMUNITY, { importId: undefined, walletId: WALLET_ID, offset: 0 });
  });

  it.each([
    "",
    "communityId=nope",
    `communityId=${COMMUNITY}&importId=nope`,
    `communityId=${COMMUNITY}&walletId=nope`,
    `communityId=${COMMUNITY}&offset=-1`,
    `communityId=${COMMUNITY}&offset=1.5`,
    `communityId=${COMMUNITY}&offset=abc`,
    `communityId=${COMMUNITY}&offset=1000001`,
  ])("rejects the query %j", async (query) => {
    const res = await GET(request(query), context);
    expect(res.status).toBe(400);
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.rows).not.toHaveBeenCalled();
  });
});
