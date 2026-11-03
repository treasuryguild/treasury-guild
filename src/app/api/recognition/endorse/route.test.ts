import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(),
  rateLimit: vi.fn(),
  loadTask: vi.fn(),
  settings: vi.fn(),
  manager: vi.fn(),
  create: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session, requireSession: mocks.session }));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.rateLimit }));
vi.mock("@/lib/db/tasks", () => ({ loadTaskForManager: mocks.loadTask }));
vi.mock("@/lib/db/recognition", () => ({
  loadRecognitionSettings: mocks.settings,
  createEndorsement: mocks.create,
}));
vi.mock("@/lib/authz", () => ({ requireWorkgroupManager: mocks.manager }));

import { POST } from "./route";

const WALLET = "addr_lead";
const TASK = "30000000-0000-4000-8000-000000000001";
const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const WG = "20000000-0000-4000-8000-000000000001";
const body = { taskId: TASK, subjectWallet: "addr_alice" };
const context = { params: Promise.resolve({}) };
const post = (payload: unknown = body) =>
  POST(new Request("http://localhost/api/recognition/endorse", {
    method: "POST",
    body: JSON.stringify(payload),
    headers: { "content-type": "application/json" },
  }), context);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.rateLimit.mockResolvedValue(undefined);
  mocks.loadTask.mockResolvedValue({
    id: TASK,
    workgroup_id: WG,
    workgroups: { community_id: COMMUNITY, name: "Dev", archived_at: null },
  });
  mocks.settings.mockResolvedValue({
    enabled: true,
    season: "quarter",
    maxEndorsementsPerActorSeason: 10,
  });
  mocks.manager.mockResolvedValue(undefined);
  mocks.create.mockResolvedValue("event-1");
});

describe("POST /api/recognition/endorse", () => {
  it("requires a session", async () => {
    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await post()).status).toBe(401);
  });

  it("404 when recognition is off", async () => {
    mocks.settings.mockResolvedValue({ enabled: false, season: "quarter" });
    expect((await post()).status).toBe(404);
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("404 when the task is missing", async () => {
    mocks.loadTask.mockResolvedValue(null);
    expect((await post()).status).toBe(404);
  });

  it("refuses when the caller is not a workgroup manager", async () => {
    mocks.manager.mockRejectedValue(new ForbiddenError("no"));
    expect((await post()).status).toBe(403);
  });

  it("creates an endorsement", async () => {
    const res = await post();
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ id: "event-1" });
    expect(mocks.rateLimit).toHaveBeenCalledWith("recognitionEndorse", WALLET);
    expect(mocks.create).toHaveBeenCalledWith(expect.objectContaining({
      taskId: TASK,
      subjectWallet: "addr_alice",
      actor: WALLET,
    }));
  });

  it("refuses an invalid body", async () => {
    expect((await post({})).status).toBe(400);
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
