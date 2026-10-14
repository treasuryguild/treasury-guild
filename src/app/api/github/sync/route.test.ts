import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError, ForbiddenError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), requireAdmin: vi.fn(), role: vi.fn(), repoLink: vi.fn(), requireActive: vi.fn(), fullSync: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireAdmin: mocks.requireAdmin, memberRole: mocks.role }));
vi.mock("@/lib/db/github", () => ({ loadRepoLink: mocks.repoLink }));
vi.mock("@/lib/db/workgroups", () => ({ requireActiveWorkgroup: mocks.requireActive }));
vi.mock("@/lib/github/sync", () => ({ fullSyncRepo: mocks.fullSync }));
import { POST } from "./route";

const context = { params: Promise.resolve({}) };
const request = (body: object) => new Request("http://localhost/api/github/sync", {
  method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
});
const repo = (overrides: object = {}) => ({
  id: 5, installation_id: 99, full_name: "guild/app", workgroup_id: "wg", community_id: "community",
  payable_label: "audited", import_status: "In review", paid_status: "Paid", ...overrides,
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: "admin" });
  mocks.requireAdmin.mockResolvedValue("admin");
  mocks.role.mockResolvedValue("admin");
  mocks.repoLink.mockResolvedValue(repo());
  mocks.requireActive.mockResolvedValue(undefined);
  mocks.fullSync.mockResolvedValue({ synced: 7, deleted: 2, skipped: 1 });
});

describe("POST /api/github/sync", () => {
  it("runs a full sync of the linked repo for an admin of its community", async () => {
    const response = await POST(request({ repoId: 5 }), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ synced: 7, deleted: 2 });
    expect(mocks.repoLink).toHaveBeenCalledWith(5);
    expect(mocks.requireAdmin).toHaveBeenCalledWith("community", "admin");
    expect(mocks.requireActive).toHaveBeenCalledWith("wg");
    expect(mocks.fullSync).toHaveBeenCalledTimes(1);
    expect(mocks.fullSync).toHaveBeenCalledWith(repo());
  });

  it("skips the archive check for a repo with no workgroup", async () => {
    mocks.repoLink.mockResolvedValue(repo({ workgroup_id: null }));
    expect((await POST(request({ repoId: 5 }), context)).status).toBe(200);
    expect(mocks.requireActive).not.toHaveBeenCalled();
    expect(mocks.fullSync).toHaveBeenCalledTimes(1);
  });

  it("answers 404 for a repo that is not linked or whose installation is gone", async () => {
    for (const row of [null, repo({ community_id: null })]) {
      mocks.repoLink.mockResolvedValueOnce(row);
      const response = await POST(request({ repoId: 5 }), context);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: "Repo not linked" });
    }
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
    expect(mocks.fullSync).not.toHaveBeenCalled();
  });

  it("answers a wallet outside the repo's community the same 404, so it cannot tell linked repos apart", async () => {
    mocks.role.mockResolvedValue(null);
    const response = await POST(request({ repoId: 5 }), context);
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({ error: "Repo not linked" });
    expect(mocks.role).toHaveBeenCalledWith("community", "admin");
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
    expect(mocks.fullSync).not.toHaveBeenCalled();
  });

  it("refuses a non-admin, an archived workgroup, a cross-site request and no session without syncing", async () => {
    mocks.requireAdmin.mockRejectedValueOnce(new ForbiddenError("Requires admin role"));
    expect((await POST(request({ repoId: 5 }), context)).status).toBe(403);
    expect(mocks.requireActive).not.toHaveBeenCalled();

    mocks.requireActive.mockRejectedValueOnce(new ConflictError("Restore this workgroup before making changes"));
    expect((await POST(request({ repoId: 5 }), context)).status).toBe(409);

    const crossSite = request({ repoId: 5 });
    crossSite.headers.set("Origin", "https://evil.test");
    expect((await POST(crossSite, context)).status).toBe(403);

    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await POST(request({ repoId: 5 }), context)).status).toBe(401);

    expect(mocks.repoLink).toHaveBeenCalledTimes(2);
    expect(mocks.fullSync).not.toHaveBeenCalled();
  });

  it("validates the repo id before any lookup", async () => {
    for (const body of [{}, { repoId: "5" }, { repoId: 0 }, { repoId: -5 }, { repoId: 1.5 }]) {
      expect((await POST(request(body), context)).status).toBe(400);
    }
    expect(mocks.repoLink).not.toHaveBeenCalled();
    expect(mocks.fullSync).not.toHaveBeenCalled();
  });
});
