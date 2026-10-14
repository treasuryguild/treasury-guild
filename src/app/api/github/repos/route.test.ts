import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError, ForbiddenError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), requireAdmin: vi.fn(), installation: vi.fn(), repoLinks: vi.fn(), ownership: vi.fn(),
  upsert: vi.fn(), hasRepos: vi.fn(), workgroupCommunity: vi.fn(), requireActive: vi.fn(), setKind: vi.fn(),
  octokit: vi.fn(), paginate: vi.fn(), githubRequest: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/db/github", () => ({
  communityInstallation: mocks.installation, loadInstallationRepoLinks: mocks.repoLinks,
  loadRepoOwnership: mocks.ownership, upsertRepoLink: mocks.upsert, workgroupHasRepos: mocks.hasRepos,
}));
vi.mock("@/lib/db/workgroups", () => ({
  workgroupCommunityId: mocks.workgroupCommunity, requireActiveWorkgroup: mocks.requireActive, setWorkgroupKind: mocks.setKind,
}));
vi.mock("@/lib/github/app", () => ({ installationOctokit: mocks.octokit }));
import { GET, POST } from "./route";

const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const WORKGROUP = "20000000-0000-4000-8000-000000000001";
const OLD_WORKGROUP = "20000000-0000-4000-8000-000000000002";
const INSTALLATION = 99;

const context = { params: Promise.resolve({}) };
const list = (query = `communityId=${COMMUNITY}`) => new Request(`http://localhost/api/github/repos?${query}`);
const request = (body: object) => new Request("http://localhost/api/github/repos", {
  method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
});
const link = (overrides: object = {}) => ({ communityId: COMMUNITY, repoId: 5, workgroupId: WORKGROUP, ...overrides });
const error = async (response: Response) => (await response.json()).error as string;
const githubError = (status: number) => Object.assign(new Error(`GitHub ${status}`), { status });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: "admin" });
  mocks.requireAdmin.mockResolvedValue("admin");
  mocks.installation.mockResolvedValue({
    installation_id: INSTALLATION, community_id: COMMUNITY, account_login: "guild-org", account_type: "Organization",
  });
  mocks.octokit.mockResolvedValue({ paginate: mocks.paginate, request: mocks.githubRequest });
  mocks.paginate.mockResolvedValue([]);
  mocks.repoLinks.mockResolvedValue([]);
  mocks.githubRequest.mockResolvedValue({ data: { id: 5, full_name: "guild-org/app" } });
  mocks.workgroupCommunity.mockResolvedValue(COMMUNITY);
  mocks.requireActive.mockResolvedValue(undefined);
  mocks.ownership.mockResolvedValue(null);
  mocks.hasRepos.mockResolvedValue(false);
});

describe("GET /api/github/repos", () => {
  it("lists the installation's repos merged with their link state", async () => {
    mocks.paginate.mockResolvedValue([
      { id: 5, full_name: "guild-org/app", private: false },
      { id: 6, full_name: "guild-org/secret", private: true },
    ]);
    mocks.repoLinks.mockResolvedValue([
      { id: 5, workgroup_id: WORKGROUP, payable_label: "audited", import_status: "In review", paid_status: "" },
      { id: 404, workgroup_id: OLD_WORKGROUP, payable_label: "x", import_status: "y", paid_status: "z" },
    ]);
    const response = await GET(list(), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      installed: true,
      accountLogin: "guild-org",
      repos: [
        { id: 5, fullName: "guild-org/app", private: false, workgroupId: WORKGROUP, payableLabel: "audited", importStatus: "In review", paidStatus: "" },
        { id: 6, fullName: "guild-org/secret", private: true, workgroupId: null, payableLabel: null, importStatus: null, paidStatus: null },
      ],
    });
    expect(mocks.requireAdmin).toHaveBeenCalledWith(COMMUNITY, "admin");
    expect(mocks.installation).toHaveBeenCalledWith(COMMUNITY);
    expect(mocks.octokit).toHaveBeenCalledWith(INSTALLATION);
    expect(mocks.paginate).toHaveBeenCalledWith("GET /installation/repositories", { per_page: 100 });
    expect(mocks.repoLinks).toHaveBeenCalledWith(INSTALLATION);
  });

  it("answers 502 when GitHub cannot list the installation's repos", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.paginate.mockRejectedValue(githubError(500));
    const response = await GET(list(), context);
    expect(response.status).toBe(502);
    expect(await error(response)).toBe("GitHub repository list failed");
    expect(mocks.repoLinks).not.toHaveBeenCalled();
  });

  it("answers not installed without asking GitHub", async () => {
    mocks.installation.mockResolvedValue(null);
    const response = await GET(list(), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ installed: false, repos: [] });
    expect(mocks.octokit).not.toHaveBeenCalled();
  });

  it("refuses no session, a non-admin and a malformed community id before any lookup", async () => {
    expect((await GET(list("communityId=nope"), context)).status).toBe(400);
    expect((await GET(list(""), context)).status).toBe(400);
    expect(mocks.requireAdmin).not.toHaveBeenCalled();

    mocks.requireAdmin.mockRejectedValue(new ForbiddenError("Requires admin role"));
    expect((await GET(list(), context)).status).toBe(403);

    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await GET(list(), context)).status).toBe(401);
    expect(mocks.installation).not.toHaveBeenCalled();
    expect(mocks.octokit).not.toHaveBeenCalled();
  });
});

describe("POST /api/github/repos", () => {
  it("links a repo under the name GitHub gives it, with the default filter, and makes the workgroup a GitHub one", async () => {
    const response = await POST(request(link({ fullName: "evil/other", installation_id: 1 })), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.requireAdmin).toHaveBeenCalledWith(COMMUNITY, "admin");
    expect(mocks.workgroupCommunity).toHaveBeenCalledWith(WORKGROUP);
    expect(mocks.requireActive).toHaveBeenCalledWith(WORKGROUP);
    expect(mocks.octokit).toHaveBeenCalledWith(INSTALLATION);
    expect(mocks.githubRequest).toHaveBeenCalledWith("GET /repositories/{repository_id}", { repository_id: 5 });
    expect(mocks.ownership).toHaveBeenCalledWith(5);
    expect(mocks.upsert).toHaveBeenCalledWith({
      id: 5, installation_id: INSTALLATION, full_name: "guild-org/app", workgroup_id: WORKGROUP,
      payable_label: "audited", import_status: "In review", paid_status: "Paid",
    });
    expect(mocks.setKind).toHaveBeenCalledTimes(1);
    expect(mocks.setKind).toHaveBeenCalledWith(WORKGROUP, "github");
  });

  it("trims a custom filter, falls back for blank ones and keeps an empty paid status as disabled", async () => {
    await POST(request(link({ payableLabel: " approved ", importStatus: " Done ", paidStatus: " Settled " })), context);
    expect(mocks.upsert).toHaveBeenLastCalledWith(expect.objectContaining({
      payable_label: "approved", import_status: "Done", paid_status: "Settled",
    }));
    await POST(request(link({ payableLabel: "  ", importStatus: "", paidStatus: "" })), context);
    expect(mocks.upsert).toHaveBeenLastCalledWith(expect.objectContaining({
      payable_label: "audited", import_status: "In review", paid_status: "",
    }));
  });

  describe("a repo that is already linked", () => {
    it("updates the link in place for the same workgroup", async () => {
      mocks.ownership.mockResolvedValue({ workgroup_id: WORKGROUP, installation_id: String(INSTALLATION) });
      expect((await POST(request(link()), context)).status).toBe(200);
      expect(mocks.hasRepos).not.toHaveBeenCalled();
      expect(mocks.setKind).toHaveBeenCalledTimes(1);
    });

    it("moves it between workgroups and makes the emptied one native again", async () => {
      mocks.ownership.mockResolvedValue({ workgroup_id: OLD_WORKGROUP, installation_id: INSTALLATION });
      expect((await POST(request(link()), context)).status).toBe(200);
      expect(mocks.requireActive).toHaveBeenCalledWith(OLD_WORKGROUP);
      expect(mocks.hasRepos).toHaveBeenCalledWith(OLD_WORKGROUP);
      expect(mocks.setKind.mock.calls).toEqual([[WORKGROUP, "github"], [OLD_WORKGROUP, "native"]]);
    });

    it("leaves the previous workgroup a GitHub one while it keeps other repos", async () => {
      mocks.ownership.mockResolvedValue({ workgroup_id: OLD_WORKGROUP, installation_id: INSTALLATION });
      mocks.hasRepos.mockResolvedValue(true);
      expect((await POST(request(link()), context)).status).toBe(200);
      expect(mocks.setKind.mock.calls).toEqual([[WORKGROUP, "github"]]);
    });

    it("refuses to move it out of an archived workgroup", async () => {
      mocks.ownership.mockResolvedValue({ workgroup_id: OLD_WORKGROUP, installation_id: INSTALLATION });
      mocks.requireActive.mockImplementation(async (id: string) => {
        if (id === OLD_WORKGROUP) throw new ConflictError("Restore this workgroup before making changes");
      });
      expect((await POST(request(link()), context)).status).toBe(409);
      expect(mocks.upsert).not.toHaveBeenCalled();
      expect(mocks.setKind).not.toHaveBeenCalled();
    });

    it("refuses a repo another community's installation has linked", async () => {
      mocks.ownership.mockResolvedValue({ workgroup_id: OLD_WORKGROUP, installation_id: 1234 });
      const response = await POST(request(link()), context);
      expect(response.status).toBe(409);
      expect(await error(response)).toBe("This repository is linked by another community");
      expect(mocks.upsert).not.toHaveBeenCalled();
      expect(mocks.setKind).not.toHaveBeenCalled();
    });
  });

  describe("what it refuses", () => {
    it("checks the repo against the installation, never trusting the body", async () => {
      for (const status of [404, 403]) {
        mocks.githubRequest.mockRejectedValue(githubError(status));
        const response = await POST(request(link({ repoId: 777 })), context);
        expect(response.status).toBe(400);
        expect(await error(response)).toBe("This repository is not available to this community's GitHub installation");
      }
      expect(mocks.githubRequest).toHaveBeenCalledWith("GET /repositories/{repository_id}", { repository_id: 777 });
      expect(mocks.ownership).not.toHaveBeenCalled();
      expect(mocks.upsert).not.toHaveBeenCalled();
      expect(mocks.setKind).not.toHaveBeenCalled();
    });

    it("answers 502 and writes nothing when GitHub itself fails", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      mocks.githubRequest.mockRejectedValue(githubError(500));
      const response = await POST(request(link()), context);
      expect(response.status).toBe(502);
      expect(await error(response)).toBe("GitHub repository lookup failed");
      expect(mocks.upsert).not.toHaveBeenCalled();
      expect(mocks.setKind).not.toHaveBeenCalled();
    });

    it("needs an installation, a workgroup of this community and an active one, before asking GitHub", async () => {
      mocks.installation.mockResolvedValueOnce(null);
      const uninstalled = await POST(request(link()), context);
      expect(uninstalled.status).toBe(400);
      expect(await error(uninstalled)).toBe("GitHub App not installed for this community");

      for (const owner of ["10000000-0000-4000-8000-000000000009", null]) {
        mocks.workgroupCommunity.mockResolvedValueOnce(owner);
        const foreign = await POST(request(link()), context);
        expect(foreign.status).toBe(400);
        expect(await error(foreign)).toBe("Workgroup not found in this community");
      }

      mocks.requireActive.mockRejectedValueOnce(new ConflictError("Restore this workgroup before making changes"));
      expect((await POST(request(link()), context)).status).toBe(409);

      expect(mocks.octokit).not.toHaveBeenCalled();
      expect(mocks.upsert).not.toHaveBeenCalled();
      expect(mocks.setKind).not.toHaveBeenCalled();
    });

    it("validates the body before any lookup", async () => {
      for (const body of [
        link({ repoId: "5" }), link({ repoId: 0 }), link({ repoId: 1.5 }), link({ workgroupId: "nope" }),
        link({ communityId: undefined }), link({ payableLabel: "x".repeat(101) }), {},
      ]) {
        expect((await POST(request(body), context)).status).toBe(400);
      }
      expect(mocks.requireAdmin).not.toHaveBeenCalled();
      expect(mocks.installation).not.toHaveBeenCalled();
      expect(mocks.octokit).not.toHaveBeenCalled();
      expect(mocks.upsert).not.toHaveBeenCalled();
    });

    it("refuses no session, a non-admin and a cross-site request", async () => {
      mocks.requireAdmin.mockRejectedValueOnce(new ForbiddenError("Requires admin role"));
      expect((await POST(request(link()), context)).status).toBe(403);

      const crossSite = request(link());
      crossSite.headers.set("Origin", "https://evil.test");
      expect((await POST(crossSite, context)).status).toBe(403);
      expect(mocks.requireAdmin).toHaveBeenCalledTimes(1);

      mocks.session.mockRejectedValue(new UnauthorizedError());
      expect((await POST(request(link()), context)).status).toBe(401);

      expect(mocks.installation).not.toHaveBeenCalled();
      expect(mocks.octokit).not.toHaveBeenCalled();
      expect(mocks.upsert).not.toHaveBeenCalled();
    });
  });
});
