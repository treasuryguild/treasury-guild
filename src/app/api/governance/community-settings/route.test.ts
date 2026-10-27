import { beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestError, ForbiddenError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), member: vi.fn(), admin: vi.fn(), load: vi.fn(), save: vi.fn(), resolveRepo: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session, requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireMember: mocks.member, requireAdmin: mocks.admin }));
vi.mock("@/lib/db/governance", () => ({
  loadGovernanceCommunitySettings: mocks.load, saveGovernanceCommunitySettings: mocks.save,
}));
vi.mock("@/lib/github/repoAccess", () => ({ resolveCommunityRepo: mocks.resolveRepo }));

import { GET, POST } from "./route";

const WALLET = "addr_test1admin";
const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const settings = {
  documentStore: null, documentStoreSince: null,
  documentArchiveRepoId: null, documentArchiveFullName: null, spendCheck: "warn",
};
const get = (query = `?communityId=${COMMUNITY}`) =>
  GET(new Request(`http://localhost/api/governance/community-settings${query}`), { params: Promise.resolve({}) });
const post = (body: object, headers: Record<string, string> = {}) =>
  POST(new Request("http://localhost/api/governance/community-settings", {
    method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers },
  }), { params: Promise.resolve({}) });
const body = (overrides: object = {}) => ({ communityId: COMMUNITY, documentStore: "ipfs", spendCheck: "refuse", ...overrides });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.member.mockResolvedValue("member");
  mocks.admin.mockResolvedValue("admin");
  mocks.load.mockResolvedValue(settings);
  mocks.save.mockResolvedValue(undefined);
  mocks.resolveRepo.mockResolvedValue({ installationId: 7, fullName: "guild/archive" });
});

describe("GET /api/governance/community-settings", () => {
  it("requires a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await get()).status).toBe(401);
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("validates the community id and requires membership", async () => {
    expect((await get("?communityId=nope")).status).toBe(400);
    mocks.member.mockRejectedValue(new ForbiddenError("Not a community member"));
    expect((await get()).status).toBe(403);
    expect(mocks.load).not.toHaveBeenCalled();
  });

  it("answers the settings to a member", async () => {
    const res = await get();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ settings });
    expect(mocks.member).toHaveBeenCalledWith(COMMUNITY, WALLET);
    expect(mocks.load).toHaveBeenCalledWith(COMMUNITY);
  });
});

describe("POST /api/governance/community-settings", () => {
  it("requires a session and refuses a cross-site request", async () => {
    mocks.session.mockRejectedValueOnce(new UnauthorizedError());
    expect((await post(body())).status).toBe(401);
    expect((await post(body(), { origin: "https://evil.test" })).status).toBe(403);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("validates the body: only the known store and the two spend-check modes", async () => {
    expect((await post(body({ documentStore: "s3" }))).status).toBe(400);
    expect((await post(body({ spendCheck: "ignore" }))).status).toBe(400);
    expect((await post(body({ documentStore: undefined }))).status).toBe(400);
    expect((await post(body({ documentStore: "github" }))).status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("requires an admin", async () => {
    mocks.admin.mockRejectedValue(new ForbiddenError("Requires admin role"));
    expect((await post(body())).status).toBe(403);
    expect(mocks.admin).toHaveBeenCalledWith(COMMUNITY, WALLET);
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("saves as the session wallet, null store included", async () => {
    expect((await post(body())).status).toBe(200);
    expect(mocks.save).toHaveBeenCalledWith(COMMUNITY, {
      documentStore: "ipfs", documentArchiveRepoId: null, documentArchiveFullName: null, spendCheck: "refuse",
    }, WALLET);
    const res = await post(body({ documentStore: null, spendCheck: "warn" }));
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.save).toHaveBeenLastCalledWith(COMMUNITY, {
      documentStore: null, documentArchiveRepoId: null, documentArchiveFullName: null, spendCheck: "warn",
    }, WALLET);
  });

  it("resolves the archive repo against the community's installations for GitHub", async () => {
    expect((await post(body({ documentStore: "github", documentArchiveRepoId: 42, spendCheck: "warn" }))).status).toBe(200);
    expect(mocks.resolveRepo).toHaveBeenCalledWith(COMMUNITY, 42);
    expect(mocks.save).toHaveBeenCalledWith(COMMUNITY, {
      documentStore: "github", documentArchiveRepoId: 42, documentArchiveFullName: "guild/archive", spendCheck: "warn",
    }, WALLET);
  });

  it("surfaces a repo the installation cannot see", async () => {
    mocks.resolveRepo.mockRejectedValue(new BadRequestError("This repository is not available to this community's GitHub installation"));
    expect((await post(body({ documentStore: "github", documentArchiveRepoId: 99 }))).status).toBe(400);
    expect(mocks.save).not.toHaveBeenCalled();
  });
});
