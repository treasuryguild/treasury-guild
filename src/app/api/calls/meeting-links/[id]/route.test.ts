import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConflictError, ForbiddenError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), manager: vi.fn(), link: vi.fn(), update: vi.fn(), remove: vi.fn(), active: vi.fn(),
}));
vi.mock("@/lib/db/workgroups", () => ({ requireActiveWorkgroup: mocks.active }));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireWorkgroupManager: mocks.manager }));
vi.mock("@/lib/db/calls", () => ({ loadCall: vi.fn() }));
vi.mock("@/lib/db/callCapture", () => ({
  loadMeetingLink: mocks.link, updateMeetingLink: mocks.update, deleteMeetingLink: mocks.remove,
}));
import { DELETE, PATCH } from "./route";

const LINK_ID = "40000000-0000-4000-8000-000000000005";
const MANAGE = "Only admins and workgroup leads can manage calls";
const LINK = {
  id: LINK_ID, community_id: "community", workgroup_id: "workgroup", provider: "zoom", meeting_ref: "12345678901",
  title: "Weekly sync", amounts: { ADA: "5" }, min_minutes: 0, duration_minutes: 60,
};

const context = { params: Promise.resolve({ id: LINK_ID }) };
const request = (method: string, body?: object) => new Request(`http://localhost/api/calls/meeting-links/${LINK_ID}`, {
  method, ...(body && { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
});
const patch = (body: object) => PATCH(request("PATCH", body), context);
const remove = () => DELETE(request("DELETE"), context);
const error = async (response: Response) => (await response.json()).error as string;
const refuseManager = () => mocks.manager.mockImplementation(
  async (_c: string, _w: string, _wallet: string, message: string) => { throw new ForbiddenError(message); },
);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: "lead" });
  mocks.link.mockResolvedValue(LINK);
  mocks.manager.mockResolvedValue(undefined);
  mocks.update.mockImplementation(async (_id: string, changes: object) => ({ ...LINK, ...changes }));
  mocks.remove.mockResolvedValue(undefined);
  mocks.active.mockResolvedValue(undefined);
});

describe("edit linked meeting API", () => {
  it("writes only the fields the body names, as columns", async () => {
    const response = await patch({ title: "Monthly sync", durationMinutes: 90 });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ link: { ...LINK, title: "Monthly sync", duration_minutes: 90 } });
    expect(mocks.link).toHaveBeenCalledWith(LINK_ID);
    expect(mocks.manager).toHaveBeenCalledWith("community", "workgroup", "lead", MANAGE);
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith(LINK_ID, { title: "Monthly sync", duration_minutes: 90 });

    await patch({ amounts: { GVT: "10" }, minMinutes: 15 });
    expect(mocks.update).toHaveBeenLastCalledWith(LINK_ID, { amounts: { GVT: "10" }, min_minutes: 15 });
  });

  it("never moves a link to another meeting, platform or workgroup", async () => {
    const response = await patch({ meetingRef: "98765432109", provider: "meet", workgroupId: "40000000-0000-4000-8000-000000000009" });
    expect(response.status).toBe(400);
    expect(await error(response)).toBe("Nothing to update");
    await patch({ title: "Monthly sync", meetingRef: "98765432109" });
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith(LINK_ID, { title: "Monthly sync" });
  });

  it("rejects malformed bodies before loading the link", async () => {
    expect(await error(await patch({}))).toBe("Nothing to update");
    for (const body of [{ title: "" }, { amounts: {} }, { minMinutes: -1 }, { durationMinutes: 0 }, { durationMinutes: 1.5 }]) {
      expect((await patch(body)).status).toBe(400);
    }
    expect(mocks.link).not.toHaveBeenCalled();
  });

  it("refuses an unknown link, a non-manager of the link's workgroup and a missing session", async () => {
    mocks.link.mockResolvedValueOnce(null);
    const missing = await patch({ title: "Monthly sync" });
    expect(missing.status).toBe(404);
    expect(await error(missing)).toBe("Linked meeting not found");
    expect(mocks.manager).not.toHaveBeenCalled();

    refuseManager();
    const forbidden = await patch({ title: "Monthly sync" });
    expect(forbidden.status).toBe(403);
    expect(await error(forbidden)).toBe(MANAGE);
    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await patch({ title: "Monthly sync" })).status).toBe(401);
    expect(mocks.update).not.toHaveBeenCalled();
  });
});

describe("a linked meeting of an archived workgroup", () => {
  it("is frozen like its calls: neither edited nor removed", async () => {
    mocks.active.mockRejectedValue(new ConflictError("Restore this workgroup before making changes"));
    for (const response of [await patch({ title: "Renamed" }), await remove()]) {
      expect(response.status).toBe(409);
      expect(await error(response)).toBe("Restore this workgroup before making changes");
    }
    expect(mocks.active).toHaveBeenCalledWith("workgroup");
    expect(mocks.update).not.toHaveBeenCalled();
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});

describe("remove linked meeting API", () => {
  it("removes the link", async () => {
    const response = await remove();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.manager).toHaveBeenCalledWith("community", "workgroup", "lead", MANAGE);
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith(LINK_ID);
  });

  it("refuses an unknown link, a missing session and a non-manager without removing anything", async () => {
    mocks.link.mockResolvedValueOnce(null);
    const missing = await remove();
    expect(missing.status).toBe(404);
    expect(await error(missing)).toBe("Linked meeting not found");
    mocks.session.mockRejectedValueOnce(new UnauthorizedError());
    expect((await remove()).status).toBe(401);
    refuseManager();
    const forbidden = await remove();
    expect(forbidden.status).toBe(403);
    expect(await error(forbidden)).toBe(MANAGE);
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});
