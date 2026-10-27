import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError, ForbiddenError, UnauthorizedError, UpstreamError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), manager: vi.fn(), community: vi.fn(), active: vi.fn(),
  taskTarget: vi.fn(), repoLink: vi.fn(), projectLinks: vi.fn(), fetchItem: vi.fn(),
  issueTask: vi.fn(), mirror: vi.fn(), updateIssue: vi.fn(), createIssue: vi.fn(),
  addItem: vi.fn(), fullSync: vi.fn(), loadAssignees: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireWorkgroupManager: mocks.manager }));
vi.mock("@/lib/db/github", () => ({
  loadGithubTaskEditTarget: mocks.taskTarget,
  loadRepoLink: mocks.repoLink,
  loadProjectLinks: mocks.projectLinks,
  loadGithubIssueTask: mocks.issueTask,
  mirrorGithubTaskEdit: mocks.mirror,
}));
vi.mock("@/lib/db/taskAssignees", () => ({ loadTaskAssignees: mocks.loadAssignees }));
vi.mock("@/lib/db/workgroups", () => ({
  requireWorkgroupCommunity: mocks.community,
  requireActiveWorkgroup: mocks.active,
}));
vi.mock("@/lib/github/issueWrite", () => ({
  updateGithubIssue: mocks.updateIssue,
  createGithubIssue: mocks.createIssue,
}));
vi.mock("@/lib/github/projectsV2", () => ({
  fetchProjectItem: mocks.fetchItem,
  addProjectItemByContentId: mocks.addItem,
}));
vi.mock("@/lib/github/sync", () => ({ fullSyncRepo: mocks.fullSync }));
import { POST } from "./route";

const WG = "20000000-0000-4000-8000-000000000001";
const TASK = "20000000-0000-4000-8000-000000000002";
const context = { params: Promise.resolve({}) };
const request = (body: object) => new Request("http://localhost/api/github/issue", {
  method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
});
const repo = {
  id: 5, installation_id: 99, full_name: "guild/app", workgroup_id: WG,
  payable_label: "audited", import_status: "In review", paid_status: "Paid", community_id: "community",
};
const task = (overrides: object = {}) => ({
  id: TASK, workgroup_id: WG, pay_state: "payable", title: "Old title", body: "Old body",
  gh_repo_id: 5, gh_issue_number: 7, gh_project_item_node_id: "PVTI_7", gh_status: "In review",
  gh_labels: ["audited"], amounts: { ADA: "10" }, bounty_lovelace: 10_000_000, ...overrides,
});

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.session.mockResolvedValue({ wallet: "lead" });
  mocks.community.mockResolvedValue("community");
  mocks.manager.mockResolvedValue(undefined);
  mocks.active.mockResolvedValue(undefined);
  mocks.taskTarget.mockResolvedValue(task());
  mocks.repoLink.mockResolvedValue(repo);
  mocks.projectLinks.mockResolvedValue([{ project_node_id: "PVT_1", installation_id: 99 }]);
  mocks.issueTask.mockResolvedValue(null);
  mocks.mirror.mockResolvedValue(undefined);
  mocks.updateIssue.mockResolvedValue({ movedToStatus: null, missingAmountFields: [] });
  mocks.createIssue.mockResolvedValue({
    number: 42, nodeId: "I_42", htmlUrl: "https://github.com/guild/app/issues/42", title: "Ship it",
  });
  mocks.addItem.mockResolvedValue({ outcome: "added", itemNodeId: "PVTI_new", status: "Todo" });
  mocks.fullSync.mockResolvedValue({ synced: 1, deleted: 0 });
  mocks.loadAssignees.mockResolvedValue([]);
});

describe("POST /api/github/issue (task)", () => {
  it("pushes a title/status edit to GitHub, mirrors it and re-syncs the repo", async () => {
    mocks.updateIssue.mockResolvedValue({ movedToStatus: "Done", missingAmountFields: [] });
    const response = await POST(request({ kind: "task", taskId: TASK, title: "New title", status: "Done" }), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      movedToStatus: "Done", missingAmountFields: [], synced: 1, deleted: 0, taskRemoved: false,
    });
    expect(mocks.manager).toHaveBeenCalledWith("community", WG, "lead", expect.any(String));
    expect(mocks.updateIssue).toHaveBeenCalledWith({
      installationId: 99, repoFullName: "guild/app", issueNumber: 7,
      projectItemNodeId: "PVTI_7", edit: { title: "New title", status: "Done" },
    });
    expect(mocks.mirror).toHaveBeenCalledWith(TASK, { title: "New title", gh_status: "Done" });
    expect(mocks.fullSync).toHaveBeenCalledWith(repo);
    // The task is still there after the re-sync.
    expect(mocks.taskTarget).toHaveBeenCalledTimes(2);
  });

  it("reports taskRemoved when the re-sync un-imports the task", async () => {
    mocks.taskTarget.mockResolvedValueOnce(task()).mockResolvedValueOnce(null);
    mocks.fullSync.mockResolvedValue({ synced: 0, deleted: 1 });
    const response = await POST(request({ kind: "task", taskId: TASK, status: "Todo" }), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ deleted: 1, taskRemoved: true });
  });

  it("still answers when the follow-up sync fails (the webhook/sweep repairs it)", async () => {
    mocks.fullSync.mockRejectedValue(new Error("db down"));
    const response = await POST(request({ kind: "task", taskId: TASK, title: "New title" }), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ synced: 0, deleted: 0, taskRemoved: false });
  });

  it("refuses amounts, labels, state, status and assignee edits on a settled task, but allows text", async () => {
    mocks.taskTarget.mockResolvedValue(task({ pay_state: "paid" }));
    for (const edit of [
      { status: "Done" }, { amounts: { ADA: "5" } }, { labels: ["audited"] },
      { state: "closed" }, { assignees: ["alice"] },
    ]) {
      expect((await POST(request({ kind: "task", taskId: TASK, ...edit }), context)).status).toBe(409);
    }
    expect(mocks.updateIssue).not.toHaveBeenCalled();
    expect((await POST(request({ kind: "task", taskId: TASK, title: "Retitled" }), context)).status).toBe(200);
    expect(mocks.updateIssue).toHaveBeenCalledTimes(1);
  });

  it("pushes assignees to GitHub and returns the synced github rows", async () => {
    mocks.loadAssignees.mockResolvedValue([
      { id: "ga", source: "github", gh_login: "alice", wallet_address: "addr1a", position: 0 },
      { id: "ma", source: "manual", gh_login: null, wallet_address: "addr1b", position: 1 },
    ]);
    const response = await POST(
      request({ kind: "task", taskId: TASK, assignees: ["alice"] }),
      context,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      movedToStatus: null, missingAmountFields: [], synced: 1, deleted: 0, taskRemoved: false,
      githubAssignees: [{ id: "ga", ghLogin: "alice", wallet: "addr1a" }],
    });
    expect(mocks.updateIssue).toHaveBeenCalledWith(expect.objectContaining({
      edit: { assignees: ["alice"] },
    }));
    expect(mocks.loadAssignees).toHaveBeenCalledWith(TASK);
  });

  it("answers 404 for a missing or non-GitHub task without touching GitHub", async () => {
    mocks.taskTarget.mockResolvedValue(null);
    expect((await POST(request({ kind: "task", taskId: TASK, title: "X" }), context)).status).toBe(404);
    mocks.taskTarget.mockResolvedValue(task({ gh_issue_number: null }));
    expect((await POST(request({ kind: "task", taskId: TASK, title: "X" }), context)).status).toBe(404);
    expect(mocks.updateIssue).not.toHaveBeenCalled();
  });

  it("refuses a non-manager, an archived workgroup and no session before writing", async () => {
    mocks.manager.mockRejectedValueOnce(new ForbiddenError("Only admins and workgroup leads can edit GitHub issues"));
    expect((await POST(request({ kind: "task", taskId: TASK, title: "X" }), context)).status).toBe(403);
    mocks.active.mockRejectedValueOnce(new ConflictError("Restore this workgroup before making changes"));
    expect((await POST(request({ kind: "task", taskId: TASK, title: "X" }), context)).status).toBe(409);
    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await POST(request({ kind: "task", taskId: TASK, title: "X" }), context)).status).toBe(401);
    expect(mocks.updateIssue).not.toHaveBeenCalled();
  });

  it("surfaces a GitHub failure as 502 after authorizing", async () => {
    mocks.updateIssue.mockRejectedValue(new UpstreamError("GitHub could not be updated"));
    const response = await POST(request({ kind: "task", taskId: TASK, title: "X" }), context);
    expect(response.status).toBe(502);
    expect(mocks.mirror).not.toHaveBeenCalled();
    expect(mocks.fullSync).not.toHaveBeenCalled();
  });

  it("validates the body before any lookup", async () => {
    for (const body of [{}, { kind: "task", taskId: TASK }, { kind: "task", taskId: "nope", title: "X" }, { kind: "item", workgroupId: WG, itemNodeId: "PVTI_1" }]) {
      expect((await POST(request(body), context)).status).toBe(400);
    }
    expect(mocks.taskTarget).not.toHaveBeenCalled();
    expect(mocks.updateIssue).not.toHaveBeenCalled();
  });
});

describe("POST /api/github/issue (item)", () => {
  const item = {
    itemNodeId: "PVTI_9", projectId: "PVT_1", fields: { status: "Todo", numbers: {} },
    issue: {
      nodeId: "I_9", number: 9, title: "Loose issue", body: null, url: "https://github.com/guild/app/issues/9",
      repoId: 5, labels: [], assigneeLogins: [],
    },
  };

  it("edits a live item that was never imported, via its repo's installation", async () => {
    mocks.fetchItem.mockResolvedValue(item);
    const response = await POST(
      request({ kind: "item", workgroupId: WG, itemNodeId: "PVTI_9", status: "In review", labels: ["audited"] }),
      context,
    );
    expect(response.status).toBe(200);
    expect(mocks.updateIssue).toHaveBeenCalledWith({
      installationId: 99, repoFullName: "guild/app", issueNumber: 9,
      projectItemNodeId: "PVTI_9", edit: { status: "In review", labels: ["audited"] },
    });
    expect(mocks.mirror).not.toHaveBeenCalled();
    expect(mocks.fullSync).toHaveBeenCalledWith(repo);
  });

  it("answers 404 when the item resolves nowhere, and 400 for a draft/PR item", async () => {
    mocks.fetchItem.mockResolvedValue(null);
    expect((await POST(request({ kind: "item", workgroupId: WG, itemNodeId: "PVTI_x", title: "X" }), context)).status).toBe(404);
    mocks.fetchItem.mockResolvedValue({ ...item, issue: null });
    expect((await POST(request({ kind: "item", workgroupId: WG, itemNodeId: "PVTI_9", title: "X" }), context)).status).toBe(400);
    expect(mocks.updateIssue).not.toHaveBeenCalled();
  });
});

describe("POST /api/github/issue (create)", () => {
  const createBody = {
    kind: "create" as const,
    workgroupId: WG,
    projectId: "PVT_1",
    repoId: 5,
    title: "Ship it",
    status: "Todo",
  };

  it("creates the issue, adds it to the project Status column and re-syncs", async () => {
    const response = await POST(request(createBody), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      number: 42,
      url: "https://github.com/guild/app/issues/42",
      itemNodeId: "PVTI_new",
    });
    expect(mocks.manager).toHaveBeenCalledWith("community", WG, "lead", expect.any(String));
    expect(mocks.createIssue).toHaveBeenCalledWith({
      installationId: 99, repoFullName: "guild/app", title: "Ship it",
    });
    expect(mocks.addItem).toHaveBeenCalledWith(99, "PVT_1", "I_42", "Todo");
    expect(mocks.fullSync).toHaveBeenCalledWith(repo);
    expect(mocks.updateIssue).not.toHaveBeenCalled();
  });

  it("refuses a repo or project that is not linked to the workgroup", async () => {
    mocks.repoLink.mockResolvedValueOnce({ ...repo, workgroup_id: "other" });
    expect((await POST(request(createBody), context)).status).toBe(400);
    expect(mocks.createIssue).not.toHaveBeenCalled();

    mocks.projectLinks.mockResolvedValueOnce([]);
    expect((await POST(request(createBody), context)).status).toBe(404);
    expect(mocks.createIssue).not.toHaveBeenCalled();
  });

  it("answers 400 when the Status column does not exist on the project", async () => {
    mocks.addItem.mockResolvedValue({ outcome: "no_option" });
    const response = await POST(request(createBody), context);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ error: expect.stringContaining("Todo") });
    expect(mocks.createIssue).toHaveBeenCalled();
  });

  it("surfaces a project-add failure as 502 after the issue was created", async () => {
    mocks.addItem.mockRejectedValue(new Error("forbidden"));
    const response = await POST(request(createBody), context);
    expect(response.status).toBe(502);
    expect(mocks.fullSync).not.toHaveBeenCalled();
  });
});
