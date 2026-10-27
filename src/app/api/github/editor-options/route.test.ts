import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), requireMember: vi.fn(), community: vi.fn(), active: vi.fn(),
  taskTarget: vi.fn(), repoLink: vi.fn(), projectLinks: vi.fn(), fetchItem: vi.fn(),
  assignable: vi.fn(), numberFields: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireMember: mocks.requireMember }));
vi.mock("@/lib/db/workgroups", () => ({
  requireWorkgroupCommunity: mocks.community,
  workgroupIsActive: mocks.active,
}));
vi.mock("@/lib/db/github", () => ({
  loadGithubTaskEditTarget: mocks.taskTarget,
  loadRepoLink: mocks.repoLink,
  loadProjectLinks: mocks.projectLinks,
}));
vi.mock("@/lib/github/assignable", () => ({ listAssignableLogins: mocks.assignable }));
vi.mock("@/lib/github/projectsV2", () => ({
  fetchProjectItem: mocks.fetchItem,
  listProjectNumberFieldNames: mocks.numberFields,
}));
import { GET } from "./route";

const WG = "20000000-0000-4000-8000-000000000001";
const TASK = "20000000-0000-4000-8000-000000000002";
const context = { params: Promise.resolve({}) };
const get = (query: string) => GET(new Request(`http://localhost/api/github/editor-options?${query}`), context);

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.session.mockResolvedValue({ wallet: "member" });
  mocks.community.mockResolvedValue("community");
  mocks.requireMember.mockResolvedValue("member");
  mocks.active.mockResolvedValue(true);
  mocks.taskTarget.mockResolvedValue({
    id: TASK, workgroup_id: WG, gh_repo_id: 5, gh_project_item_node_id: "PVTI_7",
  });
  mocks.repoLink.mockResolvedValue({
    id: 5, installation_id: 99, full_name: "guild/app", workgroup_id: WG, community_id: "community",
  });
  mocks.assignable.mockResolvedValue(["alice", "bob"]);
  mocks.numberFields.mockResolvedValue(["ADA", "SIGN"]);
});

describe("GET /api/github/editor-options", () => {
  it("returns assignable logins and number fields for an imported task", async () => {
    const response = await get(`taskId=${TASK}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      assignableLogins: ["alice", "bob"],
      numberFieldNames: ["ADA", "SIGN"],
    });
    expect(mocks.assignable).toHaveBeenCalledWith(99, "guild/app");
    expect(mocks.numberFields).toHaveBeenCalledWith(99, "PVTI_7");
  });

  it("skips number fields when the task has no project item", async () => {
    mocks.taskTarget.mockResolvedValue({
      id: TASK, workgroup_id: WG, gh_repo_id: 5, gh_project_item_node_id: null,
    });
    const response = await get(`taskId=${TASK}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      assignableLogins: ["alice", "bob"],
      numberFieldNames: [],
    });
    expect(mocks.numberFields).not.toHaveBeenCalled();
  });

  it("resolves a live project item the same way as the issue edit route", async () => {
    mocks.fetchItem.mockResolvedValue({
      itemNodeId: "PVTI_9",
      issue: { repoId: 5, number: 9 },
    });
    mocks.projectLinks.mockResolvedValue([{ installation_id: 99 }]);
    const response = await get(`workgroupId=${WG}&itemNodeId=PVTI_9`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      assignableLogins: ["alice", "bob"],
      numberFieldNames: ["ADA", "SIGN"],
    });
    expect(mocks.numberFields).toHaveBeenCalledWith(99, "PVTI_9");
  });

  it("answers empty lists for an archived workgroup without calling GitHub", async () => {
    mocks.active.mockResolvedValue(false);
    const response = await get(`taskId=${TASK}`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ assignableLogins: [], numberFieldNames: [] });
    expect(mocks.assignable).not.toHaveBeenCalled();
  });

  it("refuses a non-member and no session", async () => {
    mocks.requireMember.mockRejectedValueOnce(new ForbiddenError("Not a member"));
    expect((await get(`taskId=${TASK}`)).status).toBe(403);
    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await get(`taskId=${TASK}`)).status).toBe(401);
  });

  it("answers 404 for a missing task", async () => {
    mocks.taskTarget.mockResolvedValue(null);
    expect((await get(`taskId=${TASK}`)).status).toBe(404);
  });

  it("validates the query", async () => {
    expect((await get("")).status).toBe(400);
    expect((await get(`workgroupId=${WG}`)).status).toBe(400);
    expect(mocks.taskTarget).not.toHaveBeenCalled();
  });
});
