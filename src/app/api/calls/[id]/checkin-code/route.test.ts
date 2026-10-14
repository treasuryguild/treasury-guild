import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), manager: vi.fn(), loadCall: vi.fn(), code: vi.fn(), setCode: vi.fn(), clearCode: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireWorkgroupManager: mocks.manager }));
vi.mock("@/lib/db/calls", () => ({
  loadCall: mocks.loadCall, loadCheckinCode: mocks.code, setCheckinCode: mocks.setCode, clearCheckinCode: mocks.clearCode,
}));
import { DELETE, GET, POST } from "./route";

const CALL_ID = "40000000-0000-4000-8000-000000000003";
const MANAGE = "Only admins and workgroup leads can manage calls";

const context = { params: Promise.resolve({ id: CALL_ID }) };
const request = (method: string) => new Request(`http://localhost/api/calls/${CALL_ID}/checkin-code`, { method });
const call = (archivedAt: string | null = null) => ({
  id: CALL_ID, community_id: "community", workgroup_id: "workgroup",
  workgroups: { archived_at: archivedAt, communities: { slug: "guild", network: 0 } },
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: "lead" });
  mocks.loadCall.mockResolvedValue(call());
  mocks.manager.mockResolvedValue(undefined);
  mocks.code.mockResolvedValue("ABC234");
  mocks.setCode.mockResolvedValue(undefined);
  mocks.clearCode.mockResolvedValue(undefined);
});

describe("check-in code API", () => {
  it("shows the current code to a manager, null when check-in is closed", async () => {
    const response = await GET(request("GET"), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ code: "ABC234" });
    expect(mocks.manager).toHaveBeenCalledWith("community", "workgroup", "lead", MANAGE);
    expect(mocks.code).toHaveBeenCalledWith(CALL_ID);
    mocks.code.mockResolvedValue(null);
    expect(await (await GET(request("GET"), context)).json()).toEqual({ code: null });
  });

  it("replaces the code with a fresh one, stored under the manager's wallet", async () => {
    const response = await POST(request("POST"), context);
    expect(response.status).toBe(200);
    const { code } = await response.json();
    expect(code).toMatch(/^[A-HJKMNP-Z2-9]{6}$/);
    expect(mocks.setCode).toHaveBeenCalledExactlyOnceWith(CALL_ID, code, "lead");
    expect((await (await POST(request("POST"), context)).json()).code).not.toBe(code);
  });

  it("closes check-in by clearing the code", async () => {
    const response = await DELETE(request("DELETE"), context);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ code: null });
    expect(mocks.clearCode).toHaveBeenCalledExactlyOnceWith(CALL_ID);
  });

  it("never shows, replaces or clears the code for anyone but a manager of the call's workgroup", async () => {
    const all = () => Promise.all([GET(request("GET"), context), POST(request("POST"), context), DELETE(request("DELETE"), context)]);
    const refused = async (status: number, message?: string) => {
      for (const response of await all()) {
        expect(response.status).toBe(status);
        const json = await response.json();
        expect(json).not.toHaveProperty("code");
        if (message) expect(json.error).toBe(message);
      }
    };
    mocks.manager.mockImplementation(async (_c: string, _w: string, _wallet: string, message: string) => {
      throw new ForbiddenError(message);
    });
    await refused(403, MANAGE);
    mocks.manager.mockResolvedValue(undefined);
    mocks.loadCall.mockResolvedValue(null);
    await refused(404, "Call not found");
    mocks.loadCall.mockResolvedValue(call("2026-09-01T00:00:00Z"));
    await refused(409, "Restore this workgroup before making changes");
    mocks.session.mockRejectedValue(new UnauthorizedError());
    await refused(401);
    expect(mocks.code).not.toHaveBeenCalled();
    expect(mocks.setCode).not.toHaveBeenCalled();
    expect(mocks.clearCode).not.toHaveBeenCalled();
  });
});
