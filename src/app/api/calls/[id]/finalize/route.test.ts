import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError, ForbiddenError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), manager: vi.fn(), loadCall: vi.fn(), recompute: vi.fn(), attendees: vi.fn(),
  finalize: vi.fn(), setups: vi.fn(), stamp: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireWorkgroupManager: mocks.manager }));
vi.mock("@/lib/db/calls", () => ({
  loadCall: mocks.loadCall, loadCallAttendees: mocks.attendees, finalizeCall: mocks.finalize,
}));
vi.mock("@/lib/db/callCapture", () => ({ recomputeCallMinutes: mocks.recompute }));
vi.mock("@/lib/db/tasks", () => ({ setBudgetMonthIfNull: mocks.stamp }));
vi.mock("@/lib/db/budgetSetups", () => ({ loadBudgetSetupsForWorkgroups: mocks.setups }));
import { POST } from "./route";

const CALL_ID = "40000000-0000-4000-8000-000000000003";
const MANAGE = "Only admins and workgroup leads can manage calls";

const context = { params: Promise.resolve({ id: CALL_ID }) };
const post = () => POST(new Request(`http://localhost/api/calls/${CALL_ID}/finalize`, { method: "POST" }), context);
const call = (overrides: object = {}) => ({
  id: CALL_ID, community_id: "community", workgroup_id: "workgroup", provider: "discord", title: "Town hall",
  starts_at: "2026-08-31T23:30:00Z", ends_at: "2026-09-01T00:30:00Z",
  amounts: { ada: "2.5", GVT: "10" }, min_snapshots: 2, min_minutes: 30,
  workgroups: { archived_at: null, communities: { slug: "guild", network: 0 } },
  ...overrides,
});
const attendee = (id: string, overrides: object = {}) => ({
  id, provider: "discord", status: "auto", snapshots_seen: 0, minutes: 0, wallet_address: `wallet-${id}`, task_id: null,
  ...overrides,
});
const LIST = [
  attendee("seen", { snapshots_seen: 2 }),
  attendee("glimpsed", { snapshots_seen: 1 }),
  attendee("checked-in", { provider: "checkin" }),
  attendee("unlinked", { provider: "manual", wallet_address: null }),
  attendee("rewarded", { snapshots_seen: 5, task_id: "task-0" }),
  attendee("excluded", { snapshots_seen: 5, status: "excluded" }),
  attendee("confirmed", { status: "confirmed" }),
  attendee("short-stay", { provider: "zoom", minutes: 29 }),
  attendee("stayed", { provider: "meet", minutes: 30 }),
];
const error = async (response: Response) => (await response.json()).error as string;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: "lead" });
  mocks.loadCall.mockResolvedValue(call());
  mocks.manager.mockResolvedValue(undefined);
  mocks.recompute.mockResolvedValue(undefined);
  mocks.attendees.mockResolvedValue(LIST);
  mocks.finalize.mockResolvedValue({ taskIds: ["task-1"], paid: 4, remaining: 3 });
  mocks.setups.mockResolvedValue(new Map());
  mocks.stamp.mockResolvedValue(undefined);
});

describe("finalize call API", () => {
  it("hands finalize_call the ready attendees only, after bringing the minutes up to date", async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ taskIds: ["task-1"], paid: 4, remaining: 3 });
    expect(mocks.manager).toHaveBeenCalledWith("community", "workgroup", "lead", MANAGE);
    expect(mocks.recompute).toHaveBeenCalledExactlyOnceWith(CALL_ID);
    expect(mocks.recompute.mock.invocationCallOrder[0]).toBeLessThan(mocks.attendees.mock.invocationCallOrder[0]!);
    expect(mocks.finalize).toHaveBeenCalledExactlyOnceWith({
      callId: CALL_ID, actor: "lead", attendeeIds: ["seen", "confirmed", "stayed"],
      chunk: 20, bountyLovelace: "2500000", amounts: { ada: "2.5", GVT: "10" },
    });
  });

  it("passes no ADA bounty for a reward paid in tokens only", async () => {
    mocks.loadCall.mockResolvedValue(call({ amounts: { GVT: "10" } }));
    await post();
    expect(mocks.finalize).toHaveBeenCalledWith(expect.objectContaining({ bountyLovelace: null, amounts: { GVT: "10" } }));
  });

  it("answers 409 when the reward changed after the call was read, stamping nothing", async () => {
    mocks.finalize.mockRejectedValue(new ConflictError("The reward changed while finalizing: reload the call and try again"));
    const response = await post();
    expect(response.status).toBe(409);
    expect((await response.json()).error).toBe("The reward changed while finalizing: reload the call and try again");
    expect(mocks.stamp).not.toHaveBeenCalled();
  });

  it("stamps the new tasks with the period the call happened in, quarter-aligned for a quarterly workgroup", async () => {
    await post();
    expect(mocks.setups).toHaveBeenCalledWith(["workgroup"]);
    expect(mocks.stamp).toHaveBeenLastCalledWith(["task-1"], "2026-08");

    mocks.setups.mockResolvedValue(new Map([["workgroup", [{ starts_on: "2026-01-01", cadence: "quarterly" }]]]));
    mocks.finalize.mockResolvedValue({ taskIds: ["task-1", "task-2"], paid: 4, remaining: 3 });
    await post();
    expect(mocks.stamp).toHaveBeenLastCalledWith(["task-1", "task-2"], "2026-07");
  });

  it("answers with the result when the stamp fails, and stamps nothing when a retry created no task", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.stamp.mockRejectedValue(new Error("db is down"));
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ taskIds: ["task-1"], paid: 4, remaining: 3 });
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();

    mocks.stamp.mockClear();
    mocks.setups.mockClear();
    mocks.finalize.mockResolvedValue({ taskIds: [], paid: 0, remaining: 3 });
    expect(await (await post()).json()).toEqual({ taskIds: [], paid: 0, remaining: 3 });
    expect(mocks.setups).not.toHaveBeenCalled();
    expect(mocks.stamp).not.toHaveBeenCalled();
  });

  it("surfaces a refusal of finalize_call and stamps nothing", async () => {
    mocks.finalize.mockRejectedValue(new ConflictError("This wallet is already on the call's list"));
    expect((await post()).status).toBe(409);
    expect(mocks.setups).not.toHaveBeenCalled();
    expect(mocks.stamp).not.toHaveBeenCalled();
  });

  it("refuses when nobody is ready", async () => {
    mocks.attendees.mockResolvedValue(LIST.filter((a) => ["glimpsed", "unlinked", "rewarded", "excluded", "short-stay"].includes(a.id)));
    const response = await post();
    expect(response.status).toBe(400);
    expect(await error(response)).toBe("Nobody to reward yet: attendees need a linked wallet");
    mocks.attendees.mockResolvedValue([]);
    expect((await post()).status).toBe(400);
    expect(mocks.finalize).not.toHaveBeenCalled();
  });

  it("refuses an unknown call, a non-manager, an archived workgroup and a missing session before touching the call", async () => {
    mocks.loadCall.mockResolvedValueOnce(null);
    expect((await post()).status).toBe(404);
    mocks.loadCall.mockResolvedValueOnce(call({ workgroups: { archived_at: "2026-09-01T00:00:00Z", communities: null } }));
    expect((await post()).status).toBe(409);
    mocks.manager.mockImplementation(async (_c: string, _w: string, _wallet: string, message: string) => {
      throw new ForbiddenError(message);
    });
    const forbidden = await post();
    expect(forbidden.status).toBe(403);
    expect(await error(forbidden)).toBe(MANAGE);
    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await post()).status).toBe(401);
    expect(mocks.recompute).not.toHaveBeenCalled();
    expect(mocks.finalize).not.toHaveBeenCalled();
  });
});
