import { beforeEach, describe, expect, it, vi } from "vitest";
import { BadRequestError, ConflictError, ForbiddenError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), manager: vi.fn(), loadCall: vi.fn(), setAmounts: vi.fn(),
  update: vi.fn(), remove: vi.fn(), captureRef: vi.fn(), replay: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireWorkgroupManager: mocks.manager }));
vi.mock("@/lib/calls/capture", () => ({ assertCaptureRef: mocks.captureRef }));
vi.mock("@/lib/calls/zoomCapture", () => ({ replayPendingZoomSessions: mocks.replay }));
vi.mock("@/lib/db/calls", () => ({
  loadCall: mocks.loadCall, setCallAmounts: mocks.setAmounts, updateCall: mocks.update, deleteCallWithoutTasks: mocks.remove,
}));
import { DELETE, PATCH } from "./route";

const CALL_ID = "40000000-0000-4000-8000-000000000003";
const MANAGE = "Only admins and workgroup leads can manage calls";

const context = { params: Promise.resolve({ id: CALL_ID }) };
const request = (method: string, body?: object) => new Request(`http://localhost/api/calls/${CALL_ID}`, {
  method, ...(body && { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }),
});
const patch = (body: object) => PATCH(request("PATCH", body), context);
const call = (overrides: object = {}) => ({
  id: CALL_ID, community_id: "community", workgroup_id: "workgroup", provider: "zoom", title: "Town hall",
  external_ref: "12345678901", starts_at: "2026-10-01T18:00:00Z", ends_at: "2026-10-01T19:00:00Z",
  amounts: { ADA: "5" }, min_snapshots: 1, min_minutes: 0, state: "open",
  workgroups: { archived_at: null, communities: { slug: "guild", network: 0 } },
  ...overrides,
});
const error = async (response: Response) => (await response.json()).error as string;
const refuseManager = () => mocks.manager.mockImplementation(
  async (_c: string, _w: string, _wallet: string, message: string) => { throw new ForbiddenError(message); },
);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: "lead" });
  mocks.loadCall.mockResolvedValue(call());
  mocks.manager.mockResolvedValue(undefined);
  mocks.setAmounts.mockImplementation(async (_id: string, amounts: object) => ({ ...call(), amounts, workgroups: undefined }));
  mocks.captureRef.mockResolvedValue(undefined);
  mocks.replay.mockResolvedValue(0);
  mocks.update.mockImplementation(async (_id: string, changes: object) => ({ ...call(), ...changes, workgroups: undefined }));
  mocks.remove.mockResolvedValue(undefined);
});

describe("edit call API", () => {
  it("writes only the fields the body names, as columns", async () => {
    const response = await patch({ title: "Renamed", minMinutes: 30 });
    expect(response.status).toBe(200);
    expect((await response.json()).call).toMatchObject({ id: CALL_ID, title: "Renamed", min_minutes: 30 });
    expect(mocks.loadCall).toHaveBeenCalledWith(CALL_ID);
    expect(mocks.manager).toHaveBeenCalledWith("community", "workgroup", "lead", MANAGE);
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith(CALL_ID, { title: "Renamed", min_minutes: 30 });
    expect(mocks.setAmounts).not.toHaveBeenCalled();
    expect(mocks.captureRef).not.toHaveBeenCalled();

    await patch({ startsAt: "2026-10-02T18:00:00Z", endsAt: "2026-10-02T19:30:00Z", minSnapshots: 0 });
    expect(mocks.update).toHaveBeenLastCalledWith(CALL_ID, {
      starts_at: "2026-10-02T18:00:00Z", ends_at: "2026-10-02T19:30:00Z", min_snapshots: 0,
    });
  });

  it("checks a new capture reference against the call's own platform, and clears one unchecked", async () => {
    expect((await patch({ externalRef: "98765432109" })).status).toBe(200);
    expect(mocks.captureRef).toHaveBeenCalledExactlyOnceWith("community", "zoom", "98765432109");
    expect(mocks.update).toHaveBeenLastCalledWith(CALL_ID, { external_ref: "98765432109" });

    expect((await patch({ externalRef: null })).status).toBe(200);
    expect(mocks.captureRef).toHaveBeenCalledTimes(1);
    expect(mocks.update).toHaveBeenLastCalledWith(CALL_ID, { external_ref: null });

    mocks.captureRef.mockRejectedValue(new BadRequestError("A Zoom meeting ID has 9 to 11 digits"));
    const refused = await patch({ externalRef: "123456789012345678" });
    expect(refused.status).toBe(400);
    expect(await error(refused)).toBe("A Zoom meeting ID has 9 to 11 digits");
    expect(mocks.update).toHaveBeenCalledTimes(2);
  });

  it("replays parked joins into an open Zoom call, whatever was edited, and survives a failed replay", async () => {
    const response = await patch({ title: "Renamed" });
    expect(mocks.replay).toHaveBeenCalledExactlyOnceWith((await response.json()).call);

    mocks.update.mockResolvedValueOnce({ ...call(), state: "finalized" });
    await patch({ title: "Renamed" });
    mocks.update.mockResolvedValueOnce({ ...call(), provider: "discord" });
    await patch({ title: "Renamed" });
    expect(mocks.replay).toHaveBeenCalledTimes(1);

    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.replay.mockRejectedValue(new Error("zoom is down"));
    expect((await patch({ title: "Renamed" })).status).toBe(200);
    expect(logged).toHaveBeenCalled();
    logged.mockRestore();
  });

  it("sets the reward through the locked check, then the other fields", async () => {
    const response = await patch({ amounts: { ADA: "7.5" } });
    expect(response.status).toBe(200);
    expect((await response.json()).call).toMatchObject({ id: CALL_ID, amounts: { ADA: "7.5" }, title: "Town hall" });
    expect(mocks.setAmounts).toHaveBeenCalledExactlyOnceWith(CALL_ID, { ADA: "7.5" });
    expect(mocks.update).not.toHaveBeenCalled();

    await patch({ amounts: { ADA: "8" }, title: "Renamed" });
    expect(mocks.setAmounts).toHaveBeenLastCalledWith(CALL_ID, { ADA: "8" });
    expect(mocks.update).toHaveBeenCalledExactlyOnceWith(CALL_ID, { title: "Renamed" });
    expect(mocks.setAmounts.mock.invocationCallOrder[1]).toBeLessThan(mocks.update.mock.invocationCallOrder[0]!);
  });

  it("saves nothing when the reward is locked by attendance tasks", async () => {
    mocks.setAmounts.mockRejectedValue(new ConflictError("The reward is locked once attendance tasks exist"));
    const locked = await patch({ amounts: { ADA: "9" }, title: "Renamed" });
    expect(locked.status).toBe(409);
    expect(await error(locked)).toBe("The reward is locked once attendance tasks exist");
    expect(mocks.update).not.toHaveBeenCalled();
    expect((await patch({ title: "Renamed" })).status).toBe(200);
  });

  it("refuses an unknown call, a non-manager, an archived workgroup and a missing session", async () => {
    mocks.loadCall.mockResolvedValueOnce(null);
    const missing = await patch({ title: "Renamed" });
    expect(missing.status).toBe(404);
    expect(await error(missing)).toBe("Call not found");
    expect(mocks.manager).not.toHaveBeenCalled();

    mocks.loadCall.mockResolvedValueOnce(call({ workgroups: { archived_at: "2026-09-01T00:00:00Z", communities: null } }));
    const archived = await patch({ title: "Renamed" });
    expect(archived.status).toBe(409);
    expect(await error(archived)).toBe("Restore this workgroup before making changes");

    refuseManager();
    const forbidden = await patch({ title: "Renamed", externalRef: "98765432109" });
    expect(forbidden.status).toBe(403);
    expect(await error(forbidden)).toBe(MANAGE);

    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await patch({ title: "Renamed" })).status).toBe(401);
    expect(mocks.captureRef).not.toHaveBeenCalled();
    expect(mocks.update).not.toHaveBeenCalled();
  });

  it("rejects malformed bodies before loading the call", async () => {
    const refusal = async (body: object) => {
      const response = await patch(body);
      expect(response.status).toBe(400);
      return error(response);
    };
    expect(await refusal({})).toBe("Nothing to update");
    expect(await refusal({ workgroupId: "40000000-0000-4000-8000-000000000009", provider: "discord" })).toBe("Nothing to update");
    expect(await refusal({ startsAt: "2026-10-02T18:00:00Z" })).toBe("Set the start and the end together");
    expect(await refusal({ endsAt: "2026-10-02T18:00:00Z" })).toBe("Set the start and the end together");
    expect(await refusal({ startsAt: "2026-10-02T18:00:00Z", endsAt: "2026-10-02T17:00:00Z" })).toBe("The call must end after it starts");
    expect(await refusal({ amounts: {} })).toBe("Set a reward per attendee");
    await refusal({ title: "" });
    await refusal({ externalRef: "abc" });
    expect(mocks.loadCall).not.toHaveBeenCalled();
  });
});

describe("delete call API", () => {
  const remove = () => DELETE(request("DELETE"), context);

  it("deletes a call that has no attendance tasks", async () => {
    const response = await remove();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true });
    expect(mocks.remove).toHaveBeenCalledExactlyOnceWith(CALL_ID);
  });

  it("keeps a call that already has attendance tasks", async () => {
    mocks.remove.mockRejectedValue(new ConflictError("This call already has attendance tasks and stays as their record"));
    const response = await remove();
    expect(response.status).toBe(409);
    expect(await error(response)).toBe("This call already has attendance tasks and stays as their record");
  });

  it("refuses an unknown call, an archived workgroup, a non-manager and a missing session without deleting", async () => {
    mocks.loadCall.mockResolvedValueOnce(null);
    expect((await remove()).status).toBe(404);
    mocks.loadCall.mockResolvedValueOnce(call({ workgroups: { archived_at: "2026-09-01T00:00:00Z", communities: null } }));
    const archived = await remove();
    expect(archived.status).toBe(409);
    expect(await error(archived)).toBe("Restore this workgroup before making changes");
    mocks.session.mockRejectedValueOnce(new UnauthorizedError());
    expect((await remove()).status).toBe(401);
    refuseManager();
    const forbidden = await remove();
    expect(forbidden.status).toBe(403);
    expect(await error(forbidden)).toBe(MANAGE);
    expect(mocks.remove).not.toHaveBeenCalled();
  });
});
