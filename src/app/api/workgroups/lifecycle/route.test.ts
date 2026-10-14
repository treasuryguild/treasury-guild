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
const request = (body: object) => new Request("http://localhost/api/workgroups/lifecycle", {
  method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
});
beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: "admin" });
  mocks.community.mockResolvedValue("community");
  mocks.rpc.mockResolvedValue({ data: null, error: null });
});
describe("workgroup lifecycle API", () => {
  it("denies non-admins before calling the lifecycle RPC", async () => {
    mocks.requireAdmin.mockRejectedValue(new ForbiddenError("Requires admin role"));
    expect((await POST(request({ workgroupId: id, action: "archive" }), context)).status).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
    expect((await GET(new Request(`http://localhost/api/workgroups/lifecycle?workgroupId=${id}`), context)).status).toBe(403);
  });
  it("uses the signed-in wallet, ignoring a supplied actor", async () => {
    const result = await POST(request({ workgroupId: id, action: "delete", confirmation: "Design", actor: "owner" }), context);
    expect(result.status).toBe(200);
    expect(mocks.rpc).toHaveBeenCalledWith("change_workgroup_lifecycle", {
      p_workgroup_id: id, p_action: "delete", p_actor: "admin", p_confirmation: "Design",
    });
  });
  it("returns a conflict when the database finds newly outstanding payments", async () => {
    mocks.rpc.mockResolvedValue({ error: { code: "23514", message: "Resolve payable tasks and pending payouts before archiving" } });
    const result = await POST(request({ workgroupId: id, action: "archive" }), context);
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ conflict: true });
  });
  it("rejects malformed identifiers/actions without mutating", async () => {
    expect((await POST(request({ workgroupId: "bad", action: "archive" }), context)).status).toBe(400);
    expect((await POST(request({ workgroupId: id, action: "purge" }), context)).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("returns not found when the workgroup is gone", async () => {
    mocks.community.mockResolvedValue(null);
    expect((await POST(request({ workgroupId: id, action: "restore" }), context)).status).toBe(404);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
