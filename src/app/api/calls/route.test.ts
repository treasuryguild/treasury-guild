import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as WorkgroupsModule from "@/lib/db/workgroups";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), manager: vi.fn(), community: vi.fn(), active: vi.fn(),
  captureRef: vi.fn(), replay: vi.fn(), insert: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireWorkgroupManager: mocks.manager }));
vi.mock("@/lib/db/workgroups", async (importOriginal) => ({
  ...(await importOriginal<typeof WorkgroupsModule>()),
  requireWorkgroupCommunity: mocks.community,
  requireActiveWorkgroup: mocks.active,
}));
vi.mock("@/lib/calls/capture", () => ({ assertCaptureRef: mocks.captureRef }));
vi.mock("@/lib/calls/zoomCapture", () => ({ replayPendingZoomSessions: mocks.replay }));
vi.mock("@/lib/db/calls", () => ({ insertCall: mocks.insert }));
import { POST } from "./route";

const WORKGROUP = "40000000-0000-4000-8000-000000000001";
const COMMUNITY = "40000000-0000-4000-8000-000000000002";
const MANAGE = "Only admins and workgroup leads can manage calls";

const context = { params: Promise.resolve({}) };
const request = (body: object) => new Request("http://localhost/api/calls", {
  method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" },
});
const body = (overrides: object = {}) => ({
  workgroupId: WORKGROUP, provider: "manual", title: "Town hall",
  startsAt: "2026-10-01T18:00:00Z", endsAt: "2026-10-01T19:00:00Z", amounts: { ADA: "5" },
  ...overrides,
});
const error = async (response: Response) => (await response.json()).error as string;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: "lead" });
  mocks.community.mockResolvedValue(COMMUNITY);
  mocks.manager.mockResolvedValue(undefined);
  mocks.active.mockResolvedValue(undefined);
  mocks.captureRef.mockResolvedValue(undefined);
  mocks.replay.mockResolvedValue(0);
  mocks.insert.mockImplementation(async (call: object) => ({ id: "call-1", state: "open", ...call }));
});

describe("create call API", () => {
  it("creates a call by hand with the default thresholds and no capture reference", async () => {
    const response = await POST(request(body()), context);
    expect(response.status).toBe(200);
    const row = {
      workgroup_id: WORKGROUP, provider: "manual", title: "Town hall", external_ref: null,
      starts_at: "2026-10-01T18:00:00Z", ends_at: "2026-10-01T19:00:00Z", amounts: { ADA: "5" },
      min_snapshots: 1, min_minutes: 0, created_by: "lead",
    };
    expect(await response.json()).toEqual({ call: { id: "call-1", state: "open", ...row } });
    expect(mocks.community).toHaveBeenCalledWith(WORKGROUP);
    expect(mocks.manager).toHaveBeenCalledWith(COMMUNITY, WORKGROUP, "lead", MANAGE);
    expect(mocks.active).toHaveBeenCalledWith(WORKGROUP);
    expect(mocks.insert).toHaveBeenCalledExactlyOnceWith(row, COMMUNITY);
    expect(mocks.captureRef).not.toHaveBeenCalled();
    expect(mocks.replay).not.toHaveBeenCalled();
  });

  it("checks a capture reference against the platform, and replays parked joins into a Zoom call only", async () => {
    const zoom = await POST(request(body({ provider: "zoom", externalRef: "12345678901", minMinutes: 20 })), context);
    expect(zoom.status).toBe(200);
    expect(mocks.captureRef).toHaveBeenLastCalledWith(COMMUNITY, "zoom", "12345678901");
    expect(mocks.insert).toHaveBeenLastCalledWith(
      expect.objectContaining({ provider: "zoom", external_ref: "12345678901", min_minutes: 20 }), COMMUNITY,
    );
    expect(mocks.replay).toHaveBeenCalledExactlyOnceWith((await zoom.json()).call);

    expect((await POST(request(body({ provider: "discord", externalRef: "123456789012345678", minSnapshots: 3 })), context)).status).toBe(200);
    expect(mocks.captureRef).toHaveBeenLastCalledWith(COMMUNITY, "discord", "123456789012345678");
    expect(mocks.insert).toHaveBeenLastCalledWith(expect.objectContaining({ min_snapshots: 3 }), COMMUNITY);
    expect(mocks.replay).toHaveBeenCalledTimes(1);
  });

  it("still answers with the call when the replay fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.replay.mockRejectedValue(new Error("zoom is down"));
    const response = await POST(request(body({ provider: "zoom", externalRef: "12345678901" })), context);
    expect(response.status).toBe(200);
    expect((await response.json()).call.id).toBe("call-1");
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  describe("who is refused", () => {
    it("needs a session", async () => {
      mocks.session.mockRejectedValue(new UnauthorizedError());
      expect((await POST(request(body()), context)).status).toBe(401);
      expect(mocks.community).not.toHaveBeenCalled();
    });

    it("is a 404 for an unknown workgroup, before any authorization", async () => {
      mocks.community.mockRejectedValue(new NotFoundError("Workgroup not found"));
      const response = await POST(request(body()), context);
      expect(response.status).toBe(404);
      expect(await error(response)).toBe("Workgroup not found");
      expect(mocks.manager).not.toHaveBeenCalled();
    });

    it("refuses whoever is neither an admin nor a lead of the workgroup, with the calls wording", async () => {
      mocks.manager.mockImplementation(async (_c: string, _w: string, _wallet: string, message: string) => {
        throw new ForbiddenError(message);
      });
      const response = await POST(request(body({ provider: "zoom", externalRef: "12345678901" })), context);
      expect(response.status).toBe(403);
      expect(await error(response)).toBe(MANAGE);
      expect(mocks.active).not.toHaveBeenCalled();
      expect(mocks.captureRef).not.toHaveBeenCalled();
      expect(mocks.insert).not.toHaveBeenCalled();
    });

    it("refuses an archived workgroup, and a reference the platform does not accept", async () => {
      mocks.active.mockRejectedValueOnce(new ConflictError("Restore this workgroup before making changes"));
      expect((await POST(request(body()), context)).status).toBe(409);
      mocks.captureRef.mockRejectedValue(new BadRequestError("Connect the community's Zoom account first"));
      const response = await POST(request(body({ provider: "zoom", externalRef: "12345678901" })), context);
      expect(response.status).toBe(400);
      expect(await error(response)).toBe("Connect the community's Zoom account first");
      expect(mocks.insert).not.toHaveBeenCalled();
    });
  });

  it("rejects malformed bodies before looking anything up", async () => {
    const refusal = async (overrides: object) => {
      const response = await POST(request(body(overrides)), context);
      expect(response.status).toBe(400);
      return error(response);
    };
    expect(await refusal({ endsAt: "2026-10-01T18:00:00Z" })).toBe("The call must end after it starts");
    expect(await refusal({ amounts: {} })).toBe("Set a reward per attendee");
    expect(await refusal({ amounts: { ADA: "0" } })).toBe("Invalid amount for ADA");
    expect(await refusal({ externalRef: "my-channel" })).toBe("externalRef: Enter a channel, a meeting ID or a Meet code");
    expect(await refusal({ title: "x".repeat(121) })).toBe("title: Title must be at most 120 characters");
    await refusal({ title: "   " });
    await refusal({ provider: "teams" });
    await refusal({ workgroupId: "wg-1" });
    await refusal({ startsAt: "tomorrow" });
    await refusal({ minSnapshots: -1 });
    await refusal({ minMinutes: 24 * 60 + 1 });
    expect(mocks.community).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });
});
