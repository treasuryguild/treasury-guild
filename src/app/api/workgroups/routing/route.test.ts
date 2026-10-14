import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as DbClient from "@/lib/db/client";
import { ForbiddenError, NotFoundError } from "@/lib/errors";
const mocks = vi.hoisted(() => ({
  rpc: vi.fn(), requireAdmin: vi.fn(), requireMember: vi.fn(), community: vi.fn(), session: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireAdmin: mocks.requireAdmin, requireMember: mocks.requireMember }));
vi.mock("@/lib/db/workgroups", () => ({
  requireWorkgroupCommunity: async (id: string) => {
    const community = await mocks.community(id);
    if (!community) throw new NotFoundError("Workgroup not found");
    return community;
  },
}));
vi.mock("@/lib/db/client", async (importOriginal) => ({
  ...(await importOriginal<typeof DbClient>()),
  serviceClient: () => ({ rpc: mocks.rpc }),
}));
import { GET, POST } from "./route";
const id = "20000000-0000-4000-8000-000000000001";
const treasury = "40000000-0000-4000-8000-000000000001";
const context = { params: Promise.resolve({}) };
const request = (body: object) => new Request("http://localhost/api/workgroups/routing", {
  method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
});
beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: "admin" });
  mocks.community.mockResolvedValue("community");
  mocks.rpc.mockResolvedValue({ data: "2026-10-01", error: null });
});
describe("workgroup routing API", () => {
  it("lets any member read the routing but only admins change it", async () => {
    mocks.rpc.mockResolvedValue({ data: { treasuryId: treasury, history: [] }, error: null });
    const status = await GET(new Request(`http://localhost/api/workgroups/routing?workgroupId=${id}`), context);
    expect(status.status).toBe(200);
    expect(mocks.requireMember).toHaveBeenCalledWith("community", "admin");
    expect(mocks.rpc).toHaveBeenCalledWith("workgroup_treasury_routing", { p_workgroup_id: id });

    mocks.requireAdmin.mockRejectedValue(new ForbiddenError("Requires admin role"));
    const denied = await POST(request({ workgroupId: id, treasuryId: treasury, effective: "next" }), context);
    expect(denied.status).toBe(403);
    expect(mocks.rpc).toHaveBeenCalledTimes(1);
  });
  it("passes the signed-in wallet and reason to the RPC and returns the effective date", async () => {
    const result = await POST(request({ workgroupId: id, treasuryId: null, effective: "current", reason: "Merged wallets", actor: "x" }), context);
    expect(result.status).toBe(200);
    expect(await result.json()).toEqual({ startsOn: "2026-10-01" });
    expect(mocks.rpc).toHaveBeenCalledWith("set_workgroup_treasury", {
      p_workgroup_id: id, p_treasury_id: null, p_effective: "current", p_actor: "admin", p_reason: "Merged wallets",
    });
  });
  it("returns a conflict when the period already has payouts", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: { code: "23514", message: "This period already has payouts from another wallet." } });
    const result = await POST(request({ workgroupId: id, treasuryId: treasury, effective: "current" }), context);
    expect(result.status).toBe(409);
    expect(await result.json()).toMatchObject({ conflict: true, error: expect.stringContaining("already has payouts") });
  });
  it("rejects malformed bodies without calling the RPC", async () => {
    expect((await POST(request({ workgroupId: id, treasuryId: "wallet", effective: "next" }), context)).status).toBe(400);
    expect((await POST(request({ workgroupId: id, treasuryId: treasury, effective: "someday" }), context)).status).toBe(400);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it("returns not found when the workgroup is gone", async () => {
    mocks.community.mockResolvedValue(null);
    expect((await POST(request({ workgroupId: id, treasuryId: treasury, effective: "next" }), context)).status).toBe(404);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
