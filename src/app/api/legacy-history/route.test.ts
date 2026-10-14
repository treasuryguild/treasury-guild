import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  admin: vi.fn(),
  overview: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireAdmin: mocks.admin }));
vi.mock("@/lib/db/legacyHistory", () => ({ loadLegacyOverview: mocks.overview }));
import { GET } from "./route";

const ADMIN = "addr_test1admin";
const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const OVERVIEW = { wallets: [{ id: "w1", name: "Old multisig" }], imports: [] };
const context = { params: Promise.resolve({}) };
const request = (query: string) => new Request(`http://localhost/api/legacy-history${query}`);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: ADMIN });
  mocks.admin.mockResolvedValue("admin");
  mocks.overview.mockResolvedValue(OVERVIEW);
});

describe("GET /api/legacy-history", () => {
  it("needs a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError("Sign in first"));
    const res = await GET(request(`?communityId=${COMMUNITY}`), context);
    expect(res.status).toBe(401);
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.overview).not.toHaveBeenCalled();
  });

  it("is admin-only", async () => {
    mocks.admin.mockRejectedValue(new ForbiddenError("Requires admin role"));
    const res = await GET(request(`?communityId=${COMMUNITY}`), context);
    expect(res.status).toBe(403);
    expect(mocks.admin).toHaveBeenCalledWith(COMMUNITY, ADMIN);
    expect(mocks.overview).not.toHaveBeenCalled();
  });

  it("returns the community's overview", async () => {
    const res = await GET(request(`?communityId=${COMMUNITY}`), context);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(OVERVIEW);
    expect(mocks.admin).toHaveBeenCalledWith(COMMUNITY, ADMIN);
    expect(mocks.overview).toHaveBeenCalledTimes(1);
    expect(mocks.overview).toHaveBeenCalledWith(COMMUNITY);
  });

  it.each(["", "?communityId=", "?communityId=not-a-uuid"])("rejects the query %j", async (query) => {
    const res = await GET(request(query), context);
    expect(res.status).toBe(400);
    expect(mocks.admin).not.toHaveBeenCalled();
    expect(mocks.overview).not.toHaveBeenCalled();
  });
});
