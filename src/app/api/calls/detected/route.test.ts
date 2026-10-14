import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as WorkgroupsModule from "@/lib/db/workgroups";
import { ForbiddenError, NotFoundError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), manager: vi.fn(), community: vi.fn(), integration: vi.fn(), events: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireWorkgroupManager: mocks.manager }));
vi.mock("@/lib/db/workgroups", async (importOriginal) => ({
  ...(await importOriginal<typeof WorkgroupsModule>()),
  requireWorkgroupCommunity: mocks.community,
}));
vi.mock("@/lib/db/calls", () => ({ loadCall: vi.fn() }));
vi.mock("@/lib/db/callCapture", () => ({ loadIntegration: mocks.integration, loadPendingMeetingEvents: mocks.events }));
import { GET } from "./route";

const WORKGROUP = "40000000-0000-4000-8000-000000000001";
const COMMUNITY = "40000000-0000-4000-8000-000000000002";
const MANAGE = "Only admins and workgroup leads can manage calls";

const context = { params: Promise.resolve({}) };
const get = (query = `?workgroupId=${WORKGROUP}`) => GET(new Request(`http://localhost/api/calls/detected${query}`), context);
const event = (overrides: object) => ({
  meetingRef: "12345678901", instance: "uuid-1", topic: null, key: "name:alice", joined: null, left: null,
  ...overrides,
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: "lead" });
  mocks.community.mockResolvedValue(COMMUNITY);
  mocks.manager.mockResolvedValue(undefined);
  mocks.integration.mockResolvedValue({ id: "integration-1", external_account_id: "zoom-account", label: "Guild Zoom" });
  mocks.events.mockResolvedValue([]);
});

describe("detected meetings API", () => {
  it("groups the connected Zoom account's parked events per occurrence, as counts and never names", async () => {
    mocks.events.mockResolvedValue([
      event({ key: "name:alice", joined: "2026-10-01T18:00:00Z", topic: "Town hall" }),
      event({ key: "name:bob", joined: "2026-10-01T18:05:00Z" }),
      event({ key: "name:bob", left: "2026-10-01T18:20:00Z" }),
      event({ instance: "uuid-0", key: "name:carol", joined: "2026-09-30T18:00:00Z" }),
      event({ instance: "uuid-0", key: "name:carol", left: "2026-09-30T18:45:00Z" }),
    ]);
    const response = await get();
    expect(response.status).toBe(200);
    const json = await response.json();
    expect(json).toEqual({ meetings: [
      { meetingRef: "12345678901", instance: "uuid-1", topic: "Town hall", startedAt: "2026-10-01T18:00:00Z", endedAt: null, participants: 2 },
      { meetingRef: "12345678901", instance: "uuid-0", topic: null, startedAt: "2026-09-30T18:00:00Z", endedAt: "2026-09-30T18:45:00Z", participants: 1 },
    ] });
    expect(JSON.stringify(json)).not.toMatch(/alice|bob|carol|zoom-account/);
    expect(mocks.community).toHaveBeenCalledWith(WORKGROUP);
    expect(mocks.manager).toHaveBeenCalledWith(COMMUNITY, WORKGROUP, "lead", MANAGE);
    expect(mocks.integration).toHaveBeenCalledWith(COMMUNITY, "zoom");
    expect(mocks.events).toHaveBeenCalledExactlyOnceWith("zoom", "zoom-account");
  });

  it("lists nothing for a community with no Zoom account connected", async () => {
    mocks.integration.mockResolvedValue(null);
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ meetings: [] });
    expect(mocks.events).not.toHaveBeenCalled();
  });

  it("refuses everyone who manages no workgroup they name, before reading any event", async () => {
    mocks.manager.mockImplementationOnce(async (_c: string, _w: string, _wallet: string, message: string) => {
      throw new ForbiddenError(message);
    });
    const forbidden = await get();
    expect(forbidden.status).toBe(403);
    expect((await forbidden.json()).error).toBe(MANAGE);

    mocks.community.mockRejectedValueOnce(new NotFoundError("Workgroup not found"));
    expect((await get()).status).toBe(404);
    expect((await get("")).status).toBe(400);
    expect((await get("?workgroupId=mine")).status).toBe(400);
    mocks.session.mockRejectedValue(new UnauthorizedError());
    expect((await get()).status).toBe(401);
    expect(mocks.integration).not.toHaveBeenCalled();
    expect(mocks.events).not.toHaveBeenCalled();
  });
});
