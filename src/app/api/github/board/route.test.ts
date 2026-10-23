import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), requireMember: vi.fn(), community: vi.fn(), active: vi.fn(), repos: vi.fn(), links: vi.fn(),
  deleteLink: vi.fn(), repoProjects: vi.fn(), board: vi.fn(), upsertLink: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireMember: mocks.requireMember }));
vi.mock("@/lib/db/workgroups", () => ({ requireWorkgroupCommunity: mocks.community, workgroupIsActive: mocks.active }));
vi.mock("@/lib/db/github", () => ({
  loadWorkgroupRepos: mocks.repos, loadProjectLinks: mocks.links, deleteProjectLink: mocks.deleteLink,
}));
vi.mock("@/lib/github/projectsV2", () => ({ fetchProjectBoard: mocks.board, fetchRepoProjects: mocks.repoProjects }));
vi.mock("@/lib/github/sync", () => ({ upsertProjectLink: mocks.upsertLink }));
import { GET } from "./route";

const WORKGROUP = "20000000-0000-4000-8000-000000000001";
const INSTALLATION = 99;
const context = { params: Promise.resolve({}) };
const get = (query = `workgroupId=${WORKGROUP}`) => GET(new Request(`http://localhost/api/github/board?${query}`), context);

// The route caches boards per project for a minute at module scope: each test uses its own project ids.
let run = 0;
const project = (name: string) => `PVT_${run}_${name}`;
const linkOf = (id: string) => ({ project_node_id: id, installation_id: INSTALLATION });
const boardOf = (id: string) => ({ id, title: `Board ${id}`, url: `https://github.com/orgs/guild/projects/${id}`, statusOptions: ["Todo"], items: [] });

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  run += 1;
  mocks.session.mockResolvedValue({ wallet: "member" });
  mocks.community.mockResolvedValue("community");
  mocks.requireMember.mockResolvedValue("member");
  mocks.active.mockResolvedValue(true);
  mocks.repos.mockResolvedValue([{ id: 5, installation_id: INSTALLATION, full_name: "guild/app" }]);
  mocks.links.mockResolvedValue([]);
  mocks.repoProjects.mockResolvedValue([]);
  mocks.board.mockImplementation(async (_installation: number, id: string) => boardOf(id));
});

describe("GET /api/github/board", () => {
  it("returns the live boards of the stored project links to any member", async () => {
    const [a, b] = [project("a"), project("b")];
    mocks.links.mockResolvedValue([linkOf(a), linkOf(b)]);
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ boards: [boardOf(a), boardOf(b)], hasRepos: true });
    expect(mocks.community).toHaveBeenCalledWith(WORKGROUP);
    expect(mocks.requireMember).toHaveBeenCalledWith("community", "member");
    expect(mocks.repos).toHaveBeenCalledWith(WORKGROUP);
    expect(mocks.links).toHaveBeenCalledWith(WORKGROUP);
    expect(mocks.board.mock.calls).toEqual([[INSTALLATION, a], [INSTALLATION, b]]);
    expect(mocks.repoProjects).not.toHaveBeenCalled();
    expect(mocks.upsertLink).not.toHaveBeenCalled();
  });

  it("serves a board fetched moments ago without asking GitHub again", async () => {
    const a = project("a");
    mocks.links.mockResolvedValue([linkOf(a)]);
    await get();
    const again = await get();
    expect(await again.json()).toEqual({ boards: [boardOf(a)], hasRepos: true });
    expect(mocks.board).toHaveBeenCalledTimes(1);
    expect(mocks.requireMember).toHaveBeenCalledTimes(2);
  });

  it("refetches instead of serving the cache when asked for a fresh board", async () => {
    const a = project("a");
    mocks.links.mockResolvedValue([linkOf(a)]);
    await get();
    const response = await get(`workgroupId=${WORKGROUP}&fresh=1`);
    expect(await response.json()).toEqual({ boards: [boardOf(a)], hasRepos: true });
    expect(mocks.board).toHaveBeenCalledTimes(2);
    // And the fresh fetch refills the cache for the next plain read.
    await get();
    expect(mocks.board).toHaveBeenCalledTimes(2);
  });

  describe("who reads it", () => {
    it("refuses no session, a malformed id, an unknown workgroup and a non-member before reading anything", async () => {
      expect((await get("workgroupId=nope")).status).toBe(400);
      expect((await get("")).status).toBe(400);
      expect(mocks.community).not.toHaveBeenCalled();

      mocks.community.mockRejectedValueOnce(new NotFoundError("Workgroup not found"));
      expect((await get()).status).toBe(404);
      expect(mocks.requireMember).not.toHaveBeenCalled();

      mocks.requireMember.mockRejectedValueOnce(new ForbiddenError("Not a community member"));
      expect((await get()).status).toBe(403);

      mocks.session.mockRejectedValue(new UnauthorizedError());
      expect((await get()).status).toBe(401);

      expect(mocks.active).not.toHaveBeenCalled();
      expect(mocks.repos).not.toHaveBeenCalled();
      expect(mocks.board).not.toHaveBeenCalled();
    });
  });

  describe("workgroups with nothing to show", () => {
    it("shows no boards for an archived workgroup", async () => {
      mocks.active.mockResolvedValue(false);
      const response = await get();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ boards: [], hasRepos: true });
      expect(mocks.active).toHaveBeenCalledWith(WORKGROUP);
      expect(mocks.repos).not.toHaveBeenCalled();
      expect(mocks.board).not.toHaveBeenCalled();
    });

    it("says so when no repo feeds the workgroup", async () => {
      mocks.repos.mockResolvedValue([]);
      expect(await (await get()).json()).toEqual({ boards: [], hasRepos: false });
      expect(mocks.links).not.toHaveBeenCalled();
      expect(mocks.repoProjects).not.toHaveBeenCalled();
    });

    it("has repos but no project", async () => {
      expect(await (await get()).json()).toEqual({ boards: [], hasRepos: true });
      expect(mocks.repoProjects).toHaveBeenCalledWith(INSTALLATION, "guild", "app");
      expect(mocks.board).not.toHaveBeenCalled();
    });
  });

  describe("discovery when no link is stored", () => {
    it("registers each repo's open projects once and fetches each board once", async () => {
      const [shared, own, closed] = [project("shared"), project("own"), project("closed")];
      mocks.repos.mockResolvedValue([
        { id: 5, installation_id: INSTALLATION, full_name: "guild/app" },
        { id: 6, installation_id: INSTALLATION, full_name: "guild/docs" },
      ]);
      mocks.repoProjects.mockImplementation(async (_installation: number, _owner: string, name: string) => name === "app"
        ? [{ id: shared, title: "Shared", closed: false }, { id: closed, title: "Old", closed: true }]
        : [{ id: shared, title: "Shared", closed: false }, { id: own, title: "Docs", closed: false }]);
      const response = await get();
      expect(await response.json()).toEqual({ boards: [boardOf(shared), boardOf(own)], hasRepos: true });
      expect(mocks.repoProjects.mock.calls).toEqual([[INSTALLATION, "guild", "app"], [INSTALLATION, "guild", "docs"]]);
      expect(mocks.upsertLink).toHaveBeenCalledWith(shared, INSTALLATION, WORKGROUP);
      expect(mocks.upsertLink).toHaveBeenCalledWith(own, INSTALLATION, WORKGROUP);
      expect(mocks.upsertLink).not.toHaveBeenCalledWith(closed, expect.anything(), expect.anything());
      expect(mocks.board.mock.calls).toEqual([[INSTALLATION, shared], [INSTALLATION, own]]);
    });

    it("skips a repo GitHub fails for and still shows the others", async () => {
      const own = project("own");
      mocks.repos.mockResolvedValue([
        { id: 5, installation_id: INSTALLATION, full_name: "guild/app" },
        { id: 6, installation_id: INSTALLATION, full_name: "guild/docs" },
      ]);
      mocks.repoProjects.mockRejectedValueOnce(new Error("GitHub is down"));
      mocks.repoProjects.mockResolvedValueOnce([{ id: own, title: "Docs", closed: false }]);
      const response = await get();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ boards: [boardOf(own)], hasRepos: true });
    });
  });

  describe("boards GitHub does not return", () => {
    it("drops the stale link of a deleted project", async () => {
      const [gone, kept] = [project("gone"), project("kept")];
      mocks.links.mockResolvedValue([linkOf(gone), linkOf(kept)]);
      mocks.board.mockImplementation(async (_installation: number, id: string) => (id === gone ? null : boardOf(id)));
      const response = await get();
      expect(await response.json()).toEqual({ boards: [boardOf(kept)], hasRepos: true });
      expect(mocks.deleteLink).toHaveBeenCalledTimes(1);
      expect(mocks.deleteLink).toHaveBeenCalledWith(gone);
    });

    it("marks the answer partial when some boards fail", async () => {
      const [broken, kept] = [project("broken"), project("kept")];
      mocks.links.mockResolvedValue([linkOf(broken), linkOf(kept)]);
      mocks.board.mockImplementation(async (_installation: number, id: string) => {
        if (id === broken) throw new Error("GitHub is down");
        return boardOf(id);
      });
      const response = await get();
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ boards: [boardOf(kept)], hasRepos: true, partial: true });
      expect(mocks.deleteLink).not.toHaveBeenCalled();
    });

    it("answers 502 when every board fails", async () => {
      mocks.links.mockResolvedValue([linkOf(project("a")), linkOf(project("b"))]);
      mocks.board.mockRejectedValue(new Error("GitHub is down"));
      const response = await get();
      expect(response.status).toBe(502);
      expect(await response.json()).toEqual({ error: "GitHub board fetch failed" });
      expect(mocks.deleteLink).not.toHaveBeenCalled();
    });
  });
});
