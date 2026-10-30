import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as WorkgroupsModule from "@/lib/db/workgroups";
import { ConflictError, ForbiddenError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({ session: vi.fn(), manager: vi.fn(), tasks: vi.fn(), ensure: vi.fn(), replace: vi.fn(), community: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireWorkgroupManager: mocks.manager }));
vi.mock("@/lib/db/workgroups", async (importOriginal) => ({
  assertWorkgroupActive: (await importOriginal<typeof WorkgroupsModule>()).assertWorkgroupActive,
}));
vi.mock("@/lib/db/membership", () => ({ ensureContributor: mocks.ensure }));
vi.mock("@/lib/db/communities", () => ({ requireCommunity: mocks.community }));
vi.mock("@/lib/db/taskAssignees", () => ({ replaceTaskAssignees: mocks.replace }));
vi.mock("@/lib/db/tasks", () => ({ loadTaskForManager: mocks.tasks }));
import { POST } from "./route";

const LEAD = "addr_test1lead";
const TASK = "30000000-0000-4000-8000-000000000001";
const WORKGROUP = "20000000-0000-4000-8000-000000000001";
const GH_1 = "50000000-0000-4000-8000-000000000001";
const GH_2 = "50000000-0000-4000-8000-000000000002";
const ALICE = "addr_test1vqsruvxw9c5kk50ujld079wdajlc3ptjhm20zg8uzn4a3cqpc7km5";
const BOB = "addr_test1vznqk7fg98mup5ycpd7w9ql62htvh4cwqzugj4x3eqdfyvgtvyz89";
const CAROL = "addr_test1vr9mtjy7453pue4fs0d6qmwwenvf6z2zay0a6a9vj3n7eeqdurjp6";

const github = (id: string, wallet: string | null = null) => ({ source: "github", id, wallet });
const manual = (wallet: string) => ({ source: "manual", wallet });
const task = (overrides: object = {}) => ({
  id: TASK, workgroup_id: WORKGROUP, pay_state: "none", archived_at: null,
  workgroups: { community_id: "community", archived_at: null },
  task_assignees: [
    { id: GH_1, source: "github", github_login: "octocat", wallet_address: null, position: 0 },
    { id: GH_2, source: "github", github_login: "hubot", wallet_address: BOB, position: 1 },
    { id: "m-1", source: "manual", github_login: null, wallet_address: CAROL, position: 2 },
  ],
  ...overrides,
});
const SAVED = [{ id: GH_1, task_id: TASK, source: "github", wallet_address: ALICE, position: 0 }];
const post = (body: object, headers: Record<string, string> = {}) => POST(new Request("http://localhost/api/tasks/assignees", {
  method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers },
}), { params: Promise.resolve({}) });
const error = async (response: Response) => (await response.json()).error as string;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: LEAD });
  mocks.tasks.mockResolvedValue(task());
  mocks.manager.mockResolvedValue(undefined);
  mocks.ensure.mockResolvedValue({ created: false });
  mocks.replace.mockResolvedValue(SAVED);
  mocks.community.mockResolvedValue({ id: "community", network: 0 });
});

function nothingWritten() {
  expect(mocks.ensure).not.toHaveBeenCalled();
  expect(mocks.replace).not.toHaveBeenCalled();
}

describe("POST /api/tasks/assignees", () => {
  it("replaces the manual rows and sets the wallets of the task's own GitHub rows, in the submitted order", async () => {
    const assignees = [manual(ALICE), github(GH_2, BOB), github(GH_1)];
    const res = await post({ taskId: TASK, assignees });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ assignees: SAVED });
    expect(mocks.tasks).toHaveBeenCalledWith(TASK);
    expect(mocks.manager).toHaveBeenCalledWith("community", WORKGROUP, LEAD, "Only admins and workgroup leads can edit assignees");
    expect(mocks.ensure.mock.calls).toEqual([[ALICE], [BOB]]);
    expect(mocks.replace).toHaveBeenCalledExactlyOnceWith(TASK, assignees);
  });

  it("lets a payable task be edited, and every manual row be removed", async () => {
    mocks.tasks.mockResolvedValue(task({ pay_state: "payable" }));
    const assignees = [github(GH_1), github(GH_2)];
    expect((await post({ taskId: TASK, assignees })).status).toBe(200);
    expect(mocks.replace).toHaveBeenCalledWith(TASK, assignees);
    expect(mocks.ensure).not.toHaveBeenCalled();
  });

  it("requires a session and the same origin", async () => {
    mocks.session.mockRejectedValueOnce(new UnauthorizedError());
    expect((await post({ taskId: TASK, assignees: [] })).status).toBe(401);
    expect((await post({ taskId: TASK, assignees: [] }, { origin: "https://evil.test" })).status).toBe(403);
    expect(mocks.tasks).not.toHaveBeenCalled();
    nothingWritten();
  });

  it("refuses a malformed body before loading the task", async () => {
    const invalid = [
      {}, { taskId: TASK }, { taskId: "nope", assignees: [] },
      { taskId: TASK, assignees: [manual("not-an-address")] },
      { taskId: TASK, assignees: [{ source: "manual" }] },
      { taskId: TASK, assignees: [{ source: "github", id: "nope", wallet: null }] },
      { taskId: TASK, assignees: [{ source: "call", wallet: ALICE }] },
      { taskId: TASK, assignees: [manual(ALICE), manual(ALICE)] },
      { taskId: TASK, assignees: [github(GH_1, ALICE), manual(ALICE)] },
    ];
    for (const body of invalid) expect((await post(body)).status).toBe(400);
    expect(mocks.tasks).not.toHaveBeenCalled();
    nothingWritten();
  });

  it("answers 404 for a task that does not exist", async () => {
    mocks.tasks.mockResolvedValue(null);
    const res = await post({ taskId: TASK, assignees: [] });
    expect(res.status).toBe(404);
    expect(await error(res)).toBe("Task not found");
    expect(mocks.manager).not.toHaveBeenCalled();
    nothingWritten();
  });

  it("refuses everyone but admins and the workgroup's leads", async () => {
    mocks.manager.mockRejectedValue(new ForbiddenError("Only admins and workgroup leads can edit assignees"));
    const res = await post({ taskId: TASK, assignees: [github(GH_1), github(GH_2), manual(ALICE)] });
    expect(res.status).toBe(403);
    expect(await error(res)).toBe("Only admins and workgroup leads can edit assignees");
    nothingWritten();
  });

  it("refuses a task of an archived workgroup and an archived task", async () => {
    const body = { taskId: TASK, assignees: [github(GH_1), github(GH_2)] };
    mocks.tasks.mockResolvedValue(task({ workgroups: { community_id: "community", archived_at: "2026-09-01T00:00:00Z" } }));
    expect((await post(body)).status).toBe(409);
    mocks.tasks.mockResolvedValue(task({ archived_at: "2026-09-01T00:00:00Z" }));
    const res = await post(body);
    expect(res.status).toBe(409);
    expect(await error(res)).toBe("Restore this task before editing assignees");
    nothingWritten();
  });

  it.each(["queued", "paid", "reconciled"])("locks the assignees of a %s task: they are its paid-to record", async (payState) => {
    mocks.tasks.mockResolvedValue(task({ pay_state: payState }));
    const res = await post({ taskId: TASK, assignees: [github(GH_1), github(GH_2)] });
    expect(res.status).toBe(409);
    expect(await error(res)).toBe("Assignees are locked once a payout has been queued or paid");
    nothingWritten();
  });

  it("never adds or removes a GitHub assignee: the submitted GitHub rows must be exactly the task's", async () => {
    const mismatches = [
      [github(GH_1)],
      [manual(ALICE)],
      [github(GH_1), github(GH_2), github("50000000-0000-4000-8000-000000000003")],
      [github(GH_1), github("50000000-0000-4000-8000-000000000003")],
      // A row listed twice cannot stand in for one left out.
      [github(GH_1), github(GH_1), github(GH_2)],
    ];
    for (const assignees of mismatches) {
      const res = await post({ taskId: TASK, assignees });
      expect(res.status).toBe(400);
      expect(await error(res)).toBe("GitHub assignees are managed on GitHub");
    }
    mocks.tasks.mockResolvedValue(task({ task_assignees: [] }));
    expect((await post({ taskId: TASK, assignees: [github(GH_1, ALICE)] })).status).toBe(400);
    nothingWritten();
  });

  it("refuses a wallet on the other network before writing anything", async () => {
    mocks.community.mockResolvedValue({ id: "community", network: 1 });
    const res = await post({ taskId: TASK, assignees: [manual(ALICE), github(GH_1), github(GH_2, BOB)] });
    expect(res.status).toBe(400);
    expect(await error(res)).toBe("This community pays on mainnet: use a mainnet address");
    expect(mocks.community).toHaveBeenCalledWith("community");
    nothingWritten();
  });

  it("refuses a mainnet wallet in a preprod community", async () => {
    const MAINNET = "addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x";
    const res = await post({ taskId: TASK, assignees: [manual(MAINNET), github(GH_1), github(GH_2, BOB)] });
    expect(res.status).toBe(400);
    expect(await error(res)).toBe("This community pays on preprod: use a preprod (addr_test…) address");
    nothingWritten();
  });

  it("passes on the database refusal of a task settled since it was read", async () => {
    mocks.replace.mockRejectedValue(new ConflictError("Assignees are locked once a payout has been queued or paid"));
    const res = await post({ taskId: TASK, assignees: [github(GH_1), github(GH_2, BOB)] });
    expect(res.status).toBe(409);
    expect(await error(res)).toBe("Assignees are locked once a payout has been queued or paid");
  });
});
