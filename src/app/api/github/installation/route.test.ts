import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, UnauthorizedError, UpstreamError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), requireAdmin: vi.fn(), owner: vi.fn(),
  deleteGithub: vi.fn(), remove: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/db/github", () => ({ installationOwner: mocks.owner }));
vi.mock("@/lib/github/app", () => ({ deleteGithubInstallation: mocks.deleteGithub }));
vi.mock("@/lib/github/disconnect", () => ({ removeInstallation: mocks.remove }));
import { DELETE } from "./route";

const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const OTHER_COMMUNITY = "10000000-0000-4000-8000-000000000002";
const INSTALLATION = 99;

const context = { params: Promise.resolve({}) };
const request = (body: object = { communityId: COMMUNITY, installationId: INSTALLATION }) => new Request("http://localhost/api/github/installation", {
  method: "DELETE", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
});
const error = async (response: Response) => (await response.json()).error as string;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: "admin" });
  mocks.requireAdmin.mockResolvedValue("admin");
  mocks.owner.mockResolvedValue({ community_id: COMMUNITY });
});

describe("DELETE /api/github/installation", () => {
  it("uninstalls the named installation on GitHub first, then removes it locally", async () => {
    const response = await DELETE(request(), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.requireAdmin).toHaveBeenCalledWith(COMMUNITY, "admin");
    expect(mocks.owner).toHaveBeenCalledWith(INSTALLATION);
    expect(mocks.deleteGithub).toHaveBeenCalledWith(INSTALLATION);
    expect(mocks.remove).toHaveBeenCalledWith(INSTALLATION);
    expect(mocks.deleteGithub.mock.invocationCallOrder[0]!).toBeLessThan(mocks.remove.mock.invocationCallOrder[0]!);
  });

  it("is idempotent when the installation is already gone", async () => {
    mocks.owner.mockResolvedValue(null);
    const response = await DELETE(request(), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.deleteGithub).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("answers 404 for another community's installation without calling GitHub", async () => {
    mocks.owner.mockResolvedValue({ community_id: OTHER_COMMUNITY });
    const response = await DELETE(request(), context);
    expect(response.status).toBe(404);
    expect(await error(response)).toBe("GitHub installation not found");
    expect(mocks.deleteGithub).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("changes nothing locally when GitHub cannot uninstall the app", async () => {
    mocks.deleteGithub.mockRejectedValue(new UpstreamError("GitHub installation could not be removed"));
    const response = await DELETE(request(), context);
    expect(response.status).toBe(502);
    expect(await error(response)).toBe("GitHub installation could not be removed");
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("validates the body before any lookup", async () => {
    for (const body of [
      {}, { communityId: "nope", installationId: INSTALLATION }, { communityId: COMMUNITY },
      { communityId: COMMUNITY, installationId: "99" }, { communityId: COMMUNITY, installationId: 0 },
      { communityId: 5, installationId: INSTALLATION },
    ]) {
      expect((await DELETE(request(body), context)).status).toBe(400);
    }
    expect(mocks.requireAdmin).not.toHaveBeenCalled();
    expect(mocks.owner).not.toHaveBeenCalled();
    expect(mocks.deleteGithub).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });

  it("refuses no session, a non-admin and a cross-site request", async () => {
    mocks.requireAdmin.mockRejectedValueOnce(new ForbiddenError("Requires admin role"));
    expect((await DELETE(request(), context)).status).toBe(403);

    const crossSite = request();
    crossSite.headers.set("Origin", "https://evil.test");
    expect((await DELETE(crossSite, context)).status).toBe(403);
    expect(mocks.requireAdmin).toHaveBeenCalledTimes(1);

    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await DELETE(request(), context)).status).toBe(401);

    expect(mocks.owner).not.toHaveBeenCalled();
    expect(mocks.deleteGithub).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});
