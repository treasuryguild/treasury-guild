import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type * as BudgetSaveModule from "@/lib/db/budgetSave";
import type * as DbClient from "@/lib/db/client";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), member: vi.fn(), admin: vi.fn(), manager: vi.fn(), active: vi.fn(), dashboard: vi.fn(),
  workgroupOwner: vi.fn(), treasuryOwner: vi.fn(), resolve: vi.fn(), rpc: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireMember: mocks.member, requireAdmin: mocks.admin, requireWorkgroupManager: mocks.manager }));
vi.mock("@/lib/db/workgroups", () => ({ requireActiveWorkgroup: mocks.active }));
vi.mock("@/lib/db/budgetDashboard", () => ({ loadBudgetDashboard: mocks.dashboard }));
vi.mock("@/lib/db/budgetSave", async (importOriginal) => ({
  ...(await importOriginal<typeof BudgetSaveModule>()),
  loadWorkgroupBudgetOwner: mocks.workgroupOwner, loadTreasuryBudgetOwner: mocks.treasuryOwner, resolveBudgetAmounts: mocks.resolve,
}));
vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof DbClient>()),
  serviceClient: () => ({ rpc: mocks.rpc }),
}));
import { GET, POST } from "./route";

const WALLET = "addr_test1lead";
const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const WORKGROUP = "20000000-0000-4000-8000-000000000001";
const TREASURY = "40000000-0000-4000-8000-000000000001";
const GVTT = `${"a".repeat(56)}47565454`;
const context = { params: Promise.resolve({}) };
const get = (query: string) => GET(new Request(`http://localhost/api/budgets${query}`), context);
const post = (value: object, headers: Record<string, string> = {}) => POST(new Request("http://localhost/api/budgets", {
  method: "POST", body: JSON.stringify(value), headers: { "Content-Type": "application/json", ...headers },
}), context);
const BUDGETS = [{ cadence: "monthly", unit: "lovelace", amount: "500000000" }, { cadence: "monthly", unit: GVTT, amount: "1000" }];
const body = (overrides: object = {}) => ({
  workgroupId: WORKGROUP, budgets: BUDGETS, budgetCadence: "monthly", mode: "recurring", startsOn: "2026-08", expectedRevision: 2,
  ...overrides,
});
const WORKGROUP_OWNER = { communityId: COMMUNITY, name: "Design", workgroupId: WORKGROUP, treasuryId: null, wallet: null, notHeldMessage: "not held" };
const TREASURY_OWNER = { communityId: COMMUNITY, name: "Main", workgroupId: null, treasuryId: TREASURY, wallet: { address: "addr_test1treasury", network: 0 }, notHeldMessage: "not held" };
const ROWS = [
  { workgroup_id: WORKGROUP, cadence: "monthly", unit: "lovelace", amount: "500000000", asset_label: "ADA", decimals: 6, created_by: WALLET, updated_at: "2026-08-02T00:00:00.000Z" },
  { workgroup_id: WORKGROUP, cadence: "monthly", unit: GVTT, amount: "1000", asset_label: "GVTT", decimals: 2, created_by: WALLET, updated_at: "2026-08-02T00:00:00.000Z" },
];

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.member.mockResolvedValue("member");
  mocks.admin.mockResolvedValue("admin");
  mocks.manager.mockResolvedValue(undefined);
  mocks.active.mockResolvedValue(undefined);
  mocks.dashboard.mockResolvedValue({ month: "2026-08", workgroups: [{ id: WORKGROUP }] });
  mocks.workgroupOwner.mockResolvedValue(WORKGROUP_OWNER);
  mocks.treasuryOwner.mockResolvedValue(TREASURY_OWNER);
  mocks.resolve.mockResolvedValue(ROWS);
  mocks.rpc.mockResolvedValue({ data: 3, error: null });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("GET /api/budgets", () => {
  it("returns a member the budgets of the chosen month and view", async () => {
    const res = await get(`?communityId=${COMMUNITY}&month=2026-08&view=recurring`);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ month: "2026-08", workgroups: [{ id: WORKGROUP }] });
    expect(mocks.member).toHaveBeenCalledWith(COMMUNITY, WALLET);
    expect(mocks.dashboard).toHaveBeenCalledExactlyOnceWith(COMMUNITY, new Date("2026-08-01T00:00:00Z"), "recurring");
  });

  it("defaults to now and the month view", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: new Date("2026-10-17T09:30:00Z") });
    expect((await get(`?communityId=${COMMUNITY}`)).status).toBe(200);
    expect(mocks.dashboard).toHaveBeenCalledExactlyOnceWith(COMMUNITY, new Date("2026-10-17T09:30:00Z"), "month");
  });

  it("requires a session, a valid query and membership", async () => {
    mocks.session.mockRejectedValueOnce(new UnauthorizedError());
    expect((await get(`?communityId=${COMMUNITY}`)).status).toBe(401);
    for (const query of ["", "?communityId=nope", `?communityId=${COMMUNITY}&month=2026-13`, `?communityId=${COMMUNITY}&view=all`]) {
      expect((await get(query)).status).toBe(400);
    }
    expect(mocks.member).not.toHaveBeenCalled();
    mocks.member.mockRejectedValue(new ForbiddenError("Not a community member"));
    expect((await get(`?communityId=${COMMUNITY}`)).status).toBe(403);
    expect(mocks.dashboard).not.toHaveBeenCalled();
  });
});

describe("POST /api/budgets", () => {
  it("saves a workgroup's setup as the session wallet and returns the new revision", async () => {
    const res = await post(body({ reason: "  Raised for the audit  ", confirmTransition: true, actor: "someone-else" }));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, revision: 3 });
    expect(mocks.workgroupOwner).toHaveBeenCalledWith(WORKGROUP);
    expect(mocks.manager).toHaveBeenCalledWith(COMMUNITY, WORKGROUP, WALLET, "Only admins and workgroup leads can manage budgets");
    expect(mocks.active).toHaveBeenCalledWith(WORKGROUP);
    expect(mocks.resolve).toHaveBeenCalledExactlyOnceWith(WORKGROUP_OWNER, BUDGETS, WALLET);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("save_budget_setup", {
      p_workgroup_id: WORKGROUP, p_treasury_id: null, p_expected_revision: 2,
      p_mode: "recurring", p_cadence: "monthly", p_starts_on: "2026-08-01",
      p_amounts: ROWS, p_actor: WALLET, p_confirm: true, p_reason: "Raised for the audit",
    });
    expect(mocks.treasuryOwner).not.toHaveBeenCalled();
    expect(mocks.admin).not.toHaveBeenCalled();
  });

  it("saves a treasury's setup for admins only, with no workgroup check", async () => {
    const quarterly = [{ cadence: "quarterly", unit: "lovelace", amount: "900000000" }];
    const res = await post(body({ workgroupId: undefined, treasuryId: TREASURY, budgets: quarterly, budgetCadence: "quarterly", mode: "quarterly", startsOn: "2026-07" }));
    expect(res.status).toBe(200);
    expect(mocks.treasuryOwner).toHaveBeenCalledWith(TREASURY);
    expect(mocks.admin).toHaveBeenCalledWith(COMMUNITY, WALLET);
    expect(mocks.resolve).toHaveBeenCalledWith(TREASURY_OWNER, quarterly, WALLET);
    expect(mocks.rpc).toHaveBeenCalledWith("save_budget_setup", expect.objectContaining({
      p_workgroup_id: null, p_treasury_id: TREASURY, p_mode: "quarterly", p_cadence: "quarterly", p_starts_on: "2026-07-01",
      p_confirm: false, p_reason: "",
    }));
    expect(mocks.manager).not.toHaveBeenCalled();
    expect(mocks.active).not.toHaveBeenCalled();
    expect(mocks.workgroupOwner).not.toHaveBeenCalled();
  });

  it("requires a session and the same origin", async () => {
    mocks.session.mockRejectedValueOnce(new UnauthorizedError());
    expect((await post(body())).status).toBe(401);
    expect((await post(body(), { origin: "https://evil.test" })).status).toBe(403);
    expect(mocks.workgroupOwner).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("refuses an invalid setup before loading the owner", async () => {
    const zero = await post(body({ budgets: [{ cadence: "monthly", unit: "lovelace", amount: "0" }] }));
    expect(zero.status).toBe(400);
    expect((await zero.json()).error).toBe("Each budget must be greater than zero");
    const invalid = [
      body({ workgroupId: undefined }),
      body({ treasuryId: TREASURY }),
      body({ workgroupId: "nope" }),
      body({ expectedRevision: -1 }),
      body({ expectedRevision: undefined }),
      body({ mode: "weekly" }),
      body({ startsOn: "2026-13" }),
      body({ budgets: [{ cadence: "monthly", unit: "lovelace", amount: "1.5" }] }),
      body({ budgets: [{ cadence: "monthly", unit: "lovelace", amount: "-1" }] }),
      body({ budgets: [BUDGETS[0], BUDGETS[0]] }),
      body({ budgets: [{ cadence: "quarterly", unit: "lovelace", amount: "1" }] }),
      body({ mode: "quarterly" }),
      body({ budgets: [], budgetCadence: "quarterly", mode: "quarterly", startsOn: "2026-08" }),
      body({ reason: "x".repeat(501) }),
    ];
    for (const value of invalid) expect((await post(value)).status).toBe(400);
    expect(mocks.workgroupOwner).not.toHaveBeenCalled();
    expect(mocks.treasuryOwner).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("refuses a workgroup budget from anyone but admins and its leads, and a treasury budget from anyone but admins", async () => {
    mocks.manager.mockRejectedValue(new ForbiddenError("Only admins and workgroup leads can manage budgets"));
    expect((await post(body())).status).toBe(403);
    mocks.admin.mockRejectedValue(new ForbiddenError("Requires admin role"));
    expect((await post(body({ workgroupId: undefined, treasuryId: TREASURY }))).status).toBe(403);
    expect(mocks.active).not.toHaveBeenCalled();
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("answers 404 for an owner that is gone and 409 for an archived workgroup", async () => {
    mocks.workgroupOwner.mockRejectedValueOnce(new NotFoundError("Workgroup not found"));
    expect((await post(body())).status).toBe(404);
    mocks.treasuryOwner.mockRejectedValueOnce(new NotFoundError("Treasury not found"));
    expect((await post(body({ workgroupId: undefined, treasuryId: TREASURY }))).status).toBe(404);
    expect(mocks.manager).not.toHaveBeenCalled();
    expect(mocks.admin).not.toHaveBeenCalled();
    mocks.active.mockRejectedValue(new ConflictError("Restore this workgroup before making changes"));
    expect((await post(body())).status).toBe(409);
    expect(mocks.resolve).not.toHaveBeenCalled();
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("saves nothing when a token cannot be resolved", async () => {
    mocks.resolve.mockRejectedValue(new BadRequestError("Every selected token must currently be held by the project's treasury wallet"));
    const res = await post(body());
    expect(res.status).toBe(400);
    expect((await res.json()).error).toBe("Every selected token must currently be held by the project's treasury wallet");
    expect(mocks.rpc).not.toHaveBeenCalled();
  });

  it("surfaces budget consent as 403: with the budget kind on, budgets change by proposal", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "42501", message: "This community changes budgets by proposal" } });
    const res = await post(body());
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({ error: "This community changes budgets by proposal" });
  });

  it.each([
    ["23514", 400, "an invalid setup"],
    ["40001", 409, "a stale revision"],
    ["P0002", 404, "an owner deleted meanwhile"],
  ])("maps the RPC's %s to %i (%s)", async (code, status) => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code, message: "Refused by save_budget_setup" } });
    const res = await post(body());
    expect(res.status).toBe(status);
    expect(await res.json()).toMatchObject({ error: "Refused by save_budget_setup" });
  });
});
