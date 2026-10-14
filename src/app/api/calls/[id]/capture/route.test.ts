import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError, ForbiddenError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({ session: vi.fn(), manager: vi.fn(), loadCall: vi.fn(), capture: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireWorkgroupManager: mocks.manager }));
vi.mock("@/lib/db/calls", () => ({ loadCall: mocks.loadCall }));
vi.mock("@/lib/calls/capture", () => ({ captureCallNow: mocks.capture }));
import { POST } from "./route";

const CALL_ID = "40000000-0000-4000-8000-000000000003";
const MANAGE = "Only admins and workgroup leads can manage calls";
const MINUTE = 60 * 1000;

const context = { params: Promise.resolve({ id: CALL_ID }) };
const post = () => POST(new Request(`http://localhost/api/calls/${CALL_ID}/capture`, { method: "POST" }), context);
const call = (overrides: object = {}) => ({
  id: CALL_ID, community_id: "community", workgroup_id: "workgroup", provider: "discord", title: "Town hall",
  external_ref: "123456789012345678", starts_at: "2026-10-01T18:00:00.000Z", ends_at: "2026-10-01T19:00:00.000Z",
  workgroups: { archived_at: null, communities: { slug: "guild", network: 0 } },
  ...overrides,
});
const error = async (response: Response) => (await response.json()).error as string;
const at = (iso: string, offsetMs = 0) => vi.setSystemTime(Date.parse(iso) + offsetMs);

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers({ toFake: ["Date"] });
  at("2026-10-01T18:30:00.000Z");
  mocks.session.mockResolvedValue({ wallet: "lead" });
  mocks.loadCall.mockResolvedValue(call());
  mocks.manager.mockResolvedValue(undefined);
  mocks.capture.mockResolvedValue({ present: 4, added: 2 });
});
afterEach(() => {
  vi.useRealTimers();
});

describe("capture-now API", () => {
  it("takes one snapshot of the running Discord call", async () => {
    const response = await post();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ present: 4, added: 2 });
    expect(mocks.manager).toHaveBeenCalledWith("community", "workgroup", "lead", MANAGE);
    expect(mocks.capture).toHaveBeenCalledExactlyOnceWith(call());
  });

  it("runs from 15 minutes before the start until the end, and at no other time", async () => {
    at("2026-10-01T18:00:00.000Z", -15 * MINUTE);
    expect((await post()).status).toBe(200);
    at("2026-10-01T19:00:00.000Z");
    expect((await post()).status).toBe(200);
    for (const [iso, offset] of [["2026-10-01T18:00:00.000Z", -15 * MINUTE - 1], ["2026-10-01T19:00:00.000Z", 1]] as const) {
      at(iso, offset);
      const response = await post();
      expect(response.status).toBe(400);
      expect(await error(response)).toBe("Snapshots are taken while the call runs");
    }
    expect(mocks.capture).toHaveBeenCalledTimes(2);
  });

  it("captures Discord calls only", async () => {
    for (const provider of ["zoom", "meet", "manual"]) {
      mocks.loadCall.mockResolvedValue(call({ provider }));
      const response = await post();
      expect(response.status).toBe(400);
      expect(await error(response)).toBe("Only Discord calls are captured from a voice channel");
    }
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("refuses an unknown call, an archived workgroup, a non-manager and a missing session without connecting to Discord", async () => {
    mocks.loadCall.mockResolvedValueOnce(null);
    const missing = await post();
    expect(missing.status).toBe(404);
    expect(await error(missing)).toBe("Call not found");
    expect(mocks.manager).not.toHaveBeenCalled();
    mocks.loadCall.mockResolvedValueOnce(call({ workgroups: { archived_at: "2026-09-01T00:00:00Z", communities: null } }));
    const archived = await post();
    expect(archived.status).toBe(409);
    expect(await error(archived)).toBe("Restore this workgroup before making changes");
    mocks.session.mockRejectedValueOnce(new UnauthorizedError());
    expect((await post()).status).toBe(401);
    mocks.manager.mockImplementation(async (_c: string, _w: string, _wallet: string, message: string) => {
      throw new ForbiddenError(message);
    });
    const forbidden = await post();
    expect(forbidden.status).toBe(403);
    expect(await error(forbidden)).toBe(MANAGE);
    expect(mocks.capture).not.toHaveBeenCalled();
  });

  it("surfaces a snapshot taken a moment ago as a conflict", async () => {
    mocks.capture.mockRejectedValue(new ConflictError("A snapshot was taken a few seconds ago. Try again in half a minute."));
    const response = await post();
    expect(response.status).toBe(409);
    expect(await error(response)).toBe("A snapshot was taken a few seconds ago. Try again in half a minute.");
  });
});
