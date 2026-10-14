import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as DbClient from "@/lib/db/client";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), requireAdmin: vi.fn(), community: vi.fn(), session: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({
  requireWorkgroupAdmin: async (id: string, wallet: string) => {
    const community = await mocks.community(id);
    if (!community) throw new NotFoundError("Workgroup not found");
    await mocks.requireAdmin(community, wallet);
    return community;
  },
}));
vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof DbClient>()),
  serviceClient: () => ({ rpc: mocks.rpc }),
}));
import { GET, POST } from "./route";
const id = "20000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({}) };
const body = { workgroupId: id, expectedRevision: 2, confirmation: "Design", reason: "Wrong setup" };
const request = (value: object) => new Request("http://localhost/api/budgets/reset", {
  method: "POST", body: JSON.stringify(value), headers: { "Content-Type": "application/json" },
});
beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: "admin" });
  mocks.community.mockResolvedValue("community");
  mocks.rpc.mockResolvedValue({ data: 3, error: null });
});
describe("budget reset API", () => {
  it("denies non-admin reads and writes before calling the RPC", async () => {
    mocks.requireAdmin.mockRejectedValue(new ForbiddenError("Requires admin role"));
    expect((await POST(request(body), context)).status).toBe(403);
    expect((await GET(new Request(`http://localhost/api/budgets/reset?workgroupId=${id}`), context)).status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("records the authenticated actor and returns the new revision", async () => {
    const response = await POST(request({ ...body, actor: "owner", reason: " Wrong setup " }), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ revision: 3 });
    expect(mocks.rpc).toHaveBeenCalledWith("reset_workgroup_budgets", {
      p_workgroup_id: id, p_expected_revision: 2, p_actor: "admin", p_confirmation: "Design", p_reason: "Wrong setup",
    });
  });
  it.each(["40001", "23514"])("returns conflicts for stale edits or payment blockers (%s)", async (code) => {
    mocks.rpc.mockResolvedValue({ error: { code, message: "Reset blocked" } });
    const response = await POST(request(body), context);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ conflict: true, error: "Reset blocked" });
  });
  it.each([{ reason: " " }, { expectedRevision: -1 }, { confirmation: "" }, { workgroupId: "bad" }])("rejects invalid reset requests %j", async (change) => {
    expect((await POST(request({ ...body, ...change }), context)).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("handles deleted workgroups", async () => {
    mocks.community.mockResolvedValue(null);
    expect((await POST(request(body), context)).status).toBe(404);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
