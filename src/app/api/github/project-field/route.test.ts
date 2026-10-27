import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, UnauthorizedError, UpstreamError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  manager: vi.fn(),
  community: vi.fn(),
  active: vi.fn(),
  taskTarget: vi.fn(),
  repoLink: vi.fn(),
  projectLinks: vi.fn(),
  fetchItem: vi.fn(),
  ensureField: vi.fn(),
  loadTreasury: vi.fn(),
  walletAssets: vi.fn(),
  upsertMappings: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireWorkgroupManager: mocks.manager }));
vi.mock("@/lib/db/workgroups", () => ({
  requireWorkgroupCommunity: mocks.community,
  requireActiveWorkgroup: mocks.active,
}));
vi.mock("@/lib/db/github", () => ({
  loadGithubTaskEditTarget: mocks.taskTarget,
  loadRepoLink: mocks.repoLink,
  loadProjectLinks: mocks.projectLinks,
}));
vi.mock("@/lib/github/projectsV2", () => ({
  fetchProjectItem: mocks.fetchItem,
  ensureProjectNumberField: mocks.ensureField,
}));
vi.mock("@/lib/db/treasuries", () => ({ loadTreasury: mocks.loadTreasury }));
vi.mock("@/lib/cardano/walletAssets", () => ({ fetchWalletAssets: mocks.walletAssets }));
vi.mock("@/lib/db/assets", () => ({ upsertAssetMappings: mocks.upsertMappings }));
import { POST } from "./route";

const WG = "20000000-0000-4000-8000-000000000001";
const TASK = "20000000-0000-4000-8000-000000000002";
const TREASURY = "20000000-0000-4000-8000-000000000003";
const UNIT = "a".repeat(56) + "bb";
const context = { params: Promise.resolve({}) };
const request = (body: object) =>
  new Request("http://localhost/api/github/project-field", {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });

beforeEach(() => {
  vi.resetAllMocks();
  vi.spyOn(console, "error").mockImplementation(() => {});
  mocks.session.mockResolvedValue({ wallet: "lead" });
  mocks.community.mockResolvedValue("community");
  mocks.manager.mockResolvedValue(undefined);
  mocks.active.mockResolvedValue(undefined);
  mocks.taskTarget.mockResolvedValue({
    id: TASK,
    workgroup_id: WG,
    gh_repo_id: 5,
    gh_project_item_node_id: "PVTI_7",
  });
  mocks.repoLink.mockResolvedValue({
    id: 5,
    installation_id: 99,
    full_name: "guild/app",
    workgroup_id: WG,
    community_id: "community",
  });
  mocks.fetchItem.mockResolvedValue({
    itemNodeId: "PVTI_7",
    projectId: "PVT_1",
    issue: { repoId: 5, number: 7 },
  });
  mocks.ensureField.mockResolvedValue({ fieldName: "ADA", created: true });
  mocks.loadTreasury.mockResolvedValue({
    id: TREASURY,
    community_id: "community",
    network: 0,
    address: "addr_test1qq",
  });
  mocks.walletAssets.mockResolvedValue({
    tokens: [{ unit: UNIT, ticker: "HOSKY", decimals: 0 }],
  });
  mocks.upsertMappings.mockResolvedValue(undefined);
});

describe("POST /api/github/project-field", () => {
  it("creates an ADA field for an imported task without writing the registry", async () => {
    const response = await POST(request({ taskId: TASK, kind: "ada", fieldName: "ada" }), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ fieldName: "ADA", created: true, unit: null });
    expect(mocks.ensureField).toHaveBeenCalledWith(99, "PVT_1", "ADA");
    expect(mocks.upsertMappings).not.toHaveBeenCalled();
  });

  it("reuses an existing field and persists a token mapping", async () => {
    mocks.ensureField.mockResolvedValue({ fieldName: "Hosky", created: false });
    const response = await POST(
      request({
        taskId: TASK,
        kind: "token",
        fieldName: "HOSKY",
        unit: UNIT,
        treasuryId: TREASURY,
      }),
      context,
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      fieldName: "Hosky",
      created: false,
      unit: UNIT,
    });
    expect(mocks.upsertMappings).toHaveBeenCalledWith("community", [
      { fieldName: "Hosky", unit: UNIT, decimals: 0 },
    ]);
  });

  it("refuses a token the treasury does not hold", async () => {
    mocks.walletAssets.mockResolvedValue({ tokens: [] });
    const response = await POST(
      request({
        taskId: TASK,
        kind: "token",
        fieldName: "HOSKY",
        unit: UNIT,
        treasuryId: TREASURY,
      }),
      context,
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      error: expect.stringMatching(/not held/i),
    });
    expect(mocks.ensureField).not.toHaveBeenCalled();
  });

  it("resolves a live project item the same way as the issue edit route", async () => {
    mocks.projectLinks.mockResolvedValue([{ installation_id: 99 }]);
    mocks.fetchItem.mockResolvedValue({
      itemNodeId: "PVTI_9",
      projectId: "PVT_2",
      issue: { repoId: 5, number: 9 },
    });
    mocks.ensureField.mockResolvedValue({ fieldName: "ADA", created: false });
    const response = await POST(
      request({ workgroupId: WG, itemNodeId: "PVTI_9", kind: "ada", fieldName: "ADA" }),
      context,
    );
    expect(response.status).toBe(200);
    expect(mocks.ensureField).toHaveBeenCalledWith(99, "PVT_2", "ADA");
  });

  it("maps GitHub failures to UpstreamError", async () => {
    mocks.ensureField.mockRejectedValue(new Error("FORBIDDEN"));
    const response = await POST(request({ taskId: TASK, kind: "ada", fieldName: "ADA" }), context);
    expect(response.status).toBe(502);
    expect(UpstreamError).toBeTruthy();
  });

  it("requires a session and a workgroup manager", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError("Sign in required"));
    expect((await POST(request({ taskId: TASK, kind: "ada", fieldName: "ADA" }), context)).status)
      .toBe(401);

    mocks.session.mockResolvedValue({ wallet: "member" });
    mocks.manager.mockRejectedValue(new ForbiddenError("nope"));
    expect((await POST(request({ taskId: TASK, kind: "ada", fieldName: "ADA" }), context)).status)
      .toBe(403);
  });
});
