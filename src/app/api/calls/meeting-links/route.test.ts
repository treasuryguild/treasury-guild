import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as WorkgroupsModule from "@/lib/db/workgroups";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), manager: vi.fn(), community: vi.fn(), active: vi.fn(), captureRef: vi.fn(), insert: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireWorkgroupManager: mocks.manager }));
vi.mock("@/lib/db/workgroups", async (importOriginal) => ({
  ...(await importOriginal<typeof WorkgroupsModule>()),
  requireWorkgroupCommunity: mocks.community,
  requireActiveWorkgroup: mocks.active,
}));
vi.mock("@/lib/db/calls", () => ({ loadCall: vi.fn() }));
vi.mock("@/lib/calls/capture", () => ({ assertCaptureRef: mocks.captureRef }));
vi.mock("@/lib/db/callCapture", () => ({ insertMeetingLink: mocks.insert }));
import { POST } from "./route";

const WORKGROUP = "40000000-0000-4000-8000-000000000001";
const COMMUNITY = "40000000-0000-4000-8000-000000000002";
const MANAGE = "Only admins and workgroup leads can manage calls";

const context = { params: Promise.resolve({}) };
const post = (overrides: object = {}) => POST(new Request("http://localhost/api/calls/meeting-links", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ workgroupId: WORKGROUP, meetingRef: "12345678901", title: "Weekly sync", amounts: { ADA: "5" }, ...overrides }),
}), context);
const error = async (response: Response) => (await response.json()).error as string;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: "lead" });
  mocks.community.mockResolvedValue(COMMUNITY);
  mocks.manager.mockResolvedValue(undefined);
  mocks.active.mockResolvedValue(undefined);
  mocks.captureRef.mockResolvedValue(undefined);
  mocks.insert.mockImplementation(async (link: object) => ({ id: "link-1", ...link }));
});

describe("link meeting API", () => {
  it("links a Zoom meeting by default, with no threshold and an hour's length", async () => {
    const response = await post();
    expect(response.status).toBe(200);
    const row = {
      workgroup_id: WORKGROUP, provider: "zoom", meeting_ref: "12345678901", title: "Weekly sync",
      amounts: { ADA: "5" }, min_minutes: 0, duration_minutes: 60, created_by: "lead",
    };
    expect(await response.json()).toEqual({ link: { id: "link-1", ...row } });
    expect(mocks.community).toHaveBeenCalledWith(WORKGROUP);
    expect(mocks.manager).toHaveBeenCalledWith(COMMUNITY, WORKGROUP, "lead", MANAGE);
    expect(mocks.active).toHaveBeenCalledWith(WORKGROUP);
    expect(mocks.captureRef).toHaveBeenCalledExactlyOnceWith(COMMUNITY, "zoom", "12345678901");
    expect(mocks.insert).toHaveBeenCalledExactlyOnceWith(row, COMMUNITY);
  });

  it("links a Meet code with its own threshold and length", async () => {
    const response = await post({ provider: "meet", meetingRef: "abc-mnop-xyz", minMinutes: 20, durationMinutes: 90 });
    expect(response.status).toBe(200);
    expect(mocks.captureRef).toHaveBeenCalledWith(COMMUNITY, "meet", "abc-mnop-xyz");
    expect(mocks.insert).toHaveBeenCalledWith(
      expect.objectContaining({ provider: "meet", meeting_ref: "abc-mnop-xyz", min_minutes: 20, duration_minutes: 90 }), COMMUNITY,
    );
  });

  it("rejects malformed bodies before looking anything up", async () => {
    const refusal = async (overrides: object) => {
      const response = await post(overrides);
      expect(response.status).toBe(400);
      return error(response);
    };
    expect(await refusal({ meetingRef: "abc-mnop-xyz" })).toBe("A Zoom meeting ID has 9 to 11 digits");
    expect(await refusal({ meetingRef: "123 4567 8901" })).toBe("A Zoom meeting ID has 9 to 11 digits");
    expect(await refusal({ provider: "meet" })).toBe("A Meet code looks like abc-mnop-xyz");
    expect(await refusal({ amounts: {} })).toBe("Set a reward per attendee");
    await refusal({ provider: "discord", meetingRef: "123456789012345678" });
    await refusal({ durationMinutes: 0 });
    await refusal({ title: "" });
    await refusal({ workgroupId: "wg-1" });
    expect(mocks.community).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("refuses an unknown workgroup, a non-manager, an archived workgroup and a missing session", async () => {
    mocks.community.mockRejectedValueOnce(new NotFoundError("Workgroup not found"));
    expect((await post()).status).toBe(404);
    expect(mocks.manager).not.toHaveBeenCalled();

    mocks.active.mockRejectedValueOnce(new ConflictError("Restore this workgroup before making changes"));
    expect((await post()).status).toBe(409);

    mocks.manager.mockImplementationOnce(async (_c: string, _w: string, _wallet: string, message: string) => {
      throw new ForbiddenError(message);
    });
    const forbidden = await post();
    expect(forbidden.status).toBe(403);
    expect(await error(forbidden)).toBe(MANAGE);

    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await post()).status).toBe(401);
    expect(mocks.captureRef).not.toHaveBeenCalled();
    expect(mocks.insert).not.toHaveBeenCalled();
  });

  it("needs the platform's host account connected, and refuses a meeting that is already linked", async () => {
    mocks.captureRef.mockRejectedValueOnce(new BadRequestError("Connect the community's Zoom account first"));
    const unconnected = await post();
    expect(unconnected.status).toBe(400);
    expect(await error(unconnected)).toBe("Connect the community's Zoom account first");
    expect(mocks.insert).not.toHaveBeenCalled();

    mocks.insert.mockRejectedValue(new ConflictError("This meeting is already linked to a workgroup"));
    const taken = await post();
    expect(taken.status).toBe(409);
    expect(await error(taken)).toBe("This meeting is already linked to a workgroup");
  });
});
