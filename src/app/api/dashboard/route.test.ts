import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({ session: vi.fn(), member: vi.fn(), budgets: vi.fn(), activity: vi.fn(), incoming: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireMember: mocks.member }));
vi.mock("@/lib/db/budgetDashboard", () => ({ loadBudgetDashboard: mocks.budgets }));
vi.mock("@/lib/db/dashboard", () => ({ loadDashboardActivity: mocks.activity, loadRecentIncoming: mocks.incoming }));
import { GET } from "./route";

const WALLET = "addr_test1member";
const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const get = (query: string) => GET(new Request(`http://localhost/api/dashboard${query}`), { params: Promise.resolve({}) });

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-17T09:30:00Z") });
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.member.mockResolvedValue("member");
  mocks.budgets.mockResolvedValue({ month: "2026-08", workgroups: [{ id: "wg" }] });
  mocks.activity.mockResolvedValue({ payouts: [{ id: "p1" }], legacy: { wallets: [] } });
  mocks.incoming.mockResolvedValue([{ id: "in-1" }]);
});
afterEach(() => {
  vi.useRealTimers();
});

function nothingLoaded() {
  expect(mocks.budgets).not.toHaveBeenCalled();
  expect(mocks.activity).not.toHaveBeenCalled();
  expect(mocks.incoming).not.toHaveBeenCalled();
}

describe("GET /api/dashboard", () => {
  it("merges the budgets, activity and recent inflows of the chosen period", async () => {
    const res = await get(`?communityId=${COMMUNITY}&month=2026-08&view=quarter`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      month: "2026-08", workgroups: [{ id: "wg" }], payouts: [{ id: "p1" }], legacy: { wallets: [] }, incoming: [{ id: "in-1" }],
    });
    expect(mocks.member).toHaveBeenCalledWith(COMMUNITY, WALLET);
    expect(mocks.budgets).toHaveBeenCalledExactlyOnceWith(COMMUNITY, new Date("2026-08-01T00:00:00Z"), "quarter");
    expect(mocks.activity).toHaveBeenCalledExactlyOnceWith(COMMUNITY, "2026-08", "quarter");
    expect(mocks.incoming).toHaveBeenCalledExactlyOnceWith(COMMUNITY);
  });

  it("defaults to the current month, in the month view", async () => {
    expect((await get(`?communityId=${COMMUNITY}`)).status).toBe(200);
    expect(mocks.budgets).toHaveBeenCalledWith(COMMUNITY, new Date("2026-10-01T00:00:00Z"), "month");
    expect(mocks.activity).toHaveBeenCalledWith(COMMUNITY, "2026-10", "month");
  });

  it("runs all time through the current month, whatever month the picker holds", async () => {
    expect((await get(`?communityId=${COMMUNITY}&month=2026-03&view=all`)).status).toBe(200);
    expect(mocks.budgets).toHaveBeenCalledWith(COMMUNITY, new Date("2026-10-01T00:00:00Z"), "all");
    expect(mocks.activity).toHaveBeenCalledWith(COMMUNITY, "2026-10", "all");
  });

  it("requires a session and a valid query before checking membership", async () => {
    mocks.session.mockRejectedValueOnce(new UnauthorizedError());
    expect((await get(`?communityId=${COMMUNITY}`)).status).toBe(401);
    for (const query of ["", "?communityId=nope", `?communityId=${COMMUNITY}&month=2026-13`, `?communityId=${COMMUNITY}&month=august`, `?communityId=${COMMUNITY}&view=recurring`]) {
      expect((await get(query)).status).toBe(400);
    }
    expect(mocks.member).not.toHaveBeenCalled();
    nothingLoaded();
  });

  it("shows nothing to a wallet outside the community", async () => {
    mocks.member.mockRejectedValue(new ForbiddenError("Not a community member"));
    expect((await get(`?communityId=${COMMUNITY}`)).status).toBe(403);
    nothingLoaded();
  });
});
