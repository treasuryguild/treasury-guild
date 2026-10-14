import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as WorkgroupsModule from "@/lib/db/workgroups";
import { ForbiddenError, NotFoundError, UnauthorizedError, UpstreamError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), manager: vi.fn(), community: vi.fn(), integration: vi.fn(), channels: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireWorkgroupManager: mocks.manager }));
vi.mock("@/lib/db/workgroups", async (importOriginal) => ({
  ...(await importOriginal<typeof WorkgroupsModule>()),
  requireWorkgroupCommunity: mocks.community,
}));
vi.mock("@/lib/db/calls", () => ({ loadCall: vi.fn() }));
vi.mock("@/lib/db/callCapture", () => ({ loadIntegration: mocks.integration }));
vi.mock("@/lib/discord/bot", () => ({ listVoiceChannels: mocks.channels }));
import { GET } from "./route";

const WORKGROUP = "40000000-0000-4000-8000-000000000001";
const COMMUNITY = "40000000-0000-4000-8000-000000000002";
const MANAGE = "Only admins and workgroup leads can manage calls";
const CHANNELS = [{ id: "123456789012345678", name: "Town hall" }, { id: "123456789012345679", name: "Stage" }];

const context = { params: Promise.resolve({}) };
const get = (query = `?workgroupId=${WORKGROUP}`) => GET(new Request(`http://localhost/api/calls/discord-channels${query}`), context);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: "lead" });
  mocks.community.mockResolvedValue(COMMUNITY);
  mocks.manager.mockResolvedValue(undefined);
  mocks.integration.mockResolvedValue({ id: "integration-1", external_account_id: "guild-1", label: "The Guild" });
  mocks.channels.mockResolvedValue(CHANNELS);
});

describe("Discord voice channels API", () => {
  it("lists the voice channels of the server the community connected, without the server's id", async () => {
    const response = await get();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ connected: true, serverName: "The Guild", channels: CHANNELS });
    expect(mocks.community).toHaveBeenCalledWith(WORKGROUP);
    expect(mocks.manager).toHaveBeenCalledWith(COMMUNITY, WORKGROUP, "lead", MANAGE);
    expect(mocks.integration).toHaveBeenCalledWith(COMMUNITY, "discord");
    expect(mocks.channels).toHaveBeenCalledExactlyOnceWith("guild-1");
  });

  it("reports not connected when no server is connected, or the bot is no longer in it", async () => {
    mocks.channels.mockResolvedValue(null);
    expect(await (await get()).json()).toEqual({ connected: false, serverName: "The Guild", channels: [] });
    mocks.integration.mockResolvedValue(null);
    expect(await (await get()).json()).toEqual({ connected: false, serverName: null, channels: [] });
    expect(mocks.channels).toHaveBeenCalledTimes(1);
  });

  it("answers 502 when Discord fails", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    mocks.channels.mockRejectedValue(new UpstreamError("Discord channel list failed (500)"));
    const response = await get();
    expect(response.status).toBe(502);
    expect((await response.json()).error).toBe("Discord channel list failed (500)");
    logged.mockRestore();
  });

  it("refuses whoever does not manage the workgroup, before asking Discord anything", async () => {
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
    expect(mocks.channels).not.toHaveBeenCalled();
  });
});
