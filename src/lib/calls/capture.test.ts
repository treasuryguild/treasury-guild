import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { TooManyRequestsError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  guilds: vi.fn(), latest: vi.fn(), record: vi.fn(), rateLimit: vi.fn(), gateway: vi.fn(),
  connected: vi.fn(), elsewhere: vi.fn(), botGuilds: vi.fn(), botId: vi.fn(), joinedAt: vi.fn(), leave: vi.fn(),
  running: vi.fn(), zoom: vi.fn(), meet: vi.fn(),
}));
vi.mock("@/lib/db/callCapture", () => ({
  loadDiscordGuilds: mocks.guilds, latestSnapshotAt: mocks.latest, recordSnapshot: mocks.record,
  loadIntegration: vi.fn(), loadRunningCalls: mocks.running,
  loadConnectedDiscordGuilds: mocks.connected, accountConnectedElsewhere: mocks.elsewhere,
}));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.rateLimit }));
vi.mock("./discordGateway", () => ({ fetchGuildStates: mocks.gateway }));
vi.mock("./meetCapture", () => ({ sweepMeetCalls: mocks.meet }));
vi.mock("./zoomCapture", () => ({ sweepZoomReports: mocks.zoom }));
vi.mock("@/lib/discord/bot", () => ({
  listVoiceChannels: vi.fn(), listBotGuilds: mocks.botGuilds, botUserId: mocks.botId, botJoinedAt: mocks.joinedAt, leaveGuild: mocks.leave,
}));
import { captureCallNow, leaveOrphanGuilds, runCallsSync } from "./capture";

const CALL = { id: "call-1", community_id: "community", external_ref: "channel-1" } as Parameters<typeof captureCallNow>[0];
const TOO_SOON = "A snapshot was taken a few seconds ago. Try again in half a minute.";

beforeAll(() => {
  process.env.DISCORD_BOT_TOKEN = "bot-token";
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.guilds.mockResolvedValue(new Map([["community", "guild-1"]]));
  mocks.latest.mockResolvedValue(null);
  mocks.rateLimit.mockResolvedValue(undefined);
  mocks.gateway.mockResolvedValue({
    guilds: new Map([["guild-1", { members: [], voice_states: [] }]]), missing: [],
  });
  mocks.record.mockResolvedValue({ present: 0, added: 0 });
});

describe("captureCallNow", () => {
  it("claims the call's one capture per 30 seconds before opening the gateway connection", async () => {
    expect(await captureCallNow(CALL)).toEqual({ present: 0, added: 0 });
    expect(mocks.rateLimit).toHaveBeenCalledExactlyOnceWith("callCapture", "call-1");
    expect(mocks.rateLimit.mock.invocationCallOrder[0]).toBeLessThan(mocks.gateway.mock.invocationCallOrder[0]!);
    expect(mocks.gateway).toHaveBeenCalledWith({ token: "bot-token", guildIds: ["guild-1"] });
    expect(mocks.record).toHaveBeenCalledWith("call-1", "manual", []);
  });

  it("refuses a second click the snapshot check could not see yet, without connecting", async () => {
    mocks.rateLimit.mockRejectedValue(new TooManyRequestsError());
    await expect(captureCallNow(CALL)).rejects.toThrow(TOO_SOON);
    expect(mocks.gateway).not.toHaveBeenCalled();
  });

  it("refuses a capture right after a recorded snapshot before claiming anything", async () => {
    mocks.latest.mockResolvedValue(new Date(Date.now() - 5_000).toISOString());
    await expect(captureCallNow(CALL)).rejects.toThrow(TOO_SOON);
    expect(mocks.rateLimit).not.toHaveBeenCalled();
    expect(mocks.gateway).not.toHaveBeenCalled();
  });
});

describe("leaveOrphanGuilds", () => {
  const NOW = new Date("2026-10-01T12:00:00.000Z");
  const env = process.env as Record<string, string | undefined>;
  let nodeEnv: string | undefined;

  beforeEach(() => {
    nodeEnv = env.NODE_ENV;
    env.NODE_ENV = "production";
    mocks.botGuilds.mockResolvedValue(["connected", "abandoned", "just-added", "gone"]);
    mocks.connected.mockResolvedValue(new Set(["connected"]));
    mocks.elsewhere.mockResolvedValue(false);
    mocks.botId.mockResolvedValue("bot-1");
    mocks.joinedAt.mockImplementation(async (guildId: string) => ({
      abandoned: "2026-10-01T09:00:00.000Z", "just-added": "2026-10-01T11:30:00.000Z", gone: null,
    } as Record<string, string | null>)[guildId]);
    mocks.leave.mockResolvedValue(undefined);
  });
  afterEach(() => {
    env.NODE_ENV = nodeEnv;
  });

  it("takes the bot out of servers no community is connected to, once it has been there an hour", async () => {
    expect(await leaveOrphanGuilds(NOW)).toEqual({ abandoned: "left", "just-added": "joined within the hour", gone: "bot already gone" });
    expect(mocks.joinedAt.mock.calls).toEqual([["abandoned", "bot-1"], ["just-added", "bot-1"], ["gone", "bot-1"]]);
    expect(mocks.leave).toHaveBeenCalledExactlyOnceWith("abandoned");
  });

  it("keeps a server an admin connected while the sweep ran", async () => {
    mocks.elsewhere.mockImplementation(async (_provider: string, guildId: string) => guildId === "abandoned");
    expect(await leaveOrphanGuilds(NOW)).toMatchObject({ abandoned: "connected meanwhile" });
    expect(mocks.elsewhere).toHaveBeenCalledWith("discord", "abandoned");
    expect(mocks.leave).not.toHaveBeenCalled();
  });

  it("asks Discord nothing more when every server is connected, and reports a failure per server", async () => {
    mocks.connected.mockResolvedValue(new Set(["connected", "abandoned", "just-added", "gone"]));
    expect(await leaveOrphanGuilds(NOW)).toEqual({});
    expect(mocks.botId).not.toHaveBeenCalled();
    mocks.connected.mockResolvedValue(new Set(["connected", "just-added", "gone"]));
    mocks.leave.mockRejectedValue(new Error("Discord leave server failed (500)"));
    expect(await leaveOrphanGuilds(NOW)).toEqual({ abandoned: "Discord leave server failed (500)" });
  });

  it("never runs outside production, where this database may not know every connection", async () => {
    env.NODE_ENV = "development";
    expect(await leaveOrphanGuilds(NOW)).toEqual({ skipped: "outside production" });
    expect(mocks.botGuilds).not.toHaveBeenCalled();
    expect(mocks.leave).not.toHaveBeenCalled();
  });

  it("looks at no more than 10 orphans per run; the rest wait for the next one", async () => {
    const orphans = Array.from({ length: 13 }, (_, i) => `orphan-${i}`);
    mocks.botGuilds.mockResolvedValue(["connected", ...orphans]);
    mocks.joinedAt.mockResolvedValue("2026-10-01T09:00:00.000Z");
    expect(Object.keys(await leaveOrphanGuilds(NOW))).toEqual(orphans.slice(0, 10));
    expect(mocks.joinedAt).toHaveBeenCalledTimes(10);
    expect(mocks.leave).toHaveBeenCalledTimes(10);
  });
});

describe("runCallsSync", () => {
  const env = process.env as Record<string, string | undefined>;
  let nodeEnv: string | undefined;

  beforeEach(() => {
    nodeEnv = env.NODE_ENV;
    env.NODE_ENV = "production";
    mocks.running.mockResolvedValue([]);
    mocks.zoom.mockResolvedValue({ "Zoom call": 3 });
    mocks.meet.mockResolvedValue({});
    mocks.connected.mockResolvedValue(new Set());
  });
  afterEach(() => {
    env.NODE_ENV = nodeEnv;
  });

  it("reports the orphan sweep beside the platform sweeps", async () => {
    mocks.botGuilds.mockResolvedValue([]);
    expect(await runCallsSync()).toEqual({ calls: 0, snapshots: 0, results: {}, zoomReports: { "Zoom call": 3 }, meetCalls: {}, orphanServers: {} });
  });

  it("keeps the other sweeps' results when the orphan sweep fails", async () => {
    mocks.botGuilds.mockRejectedValue(new Error("Discord server list failed (500)"));
    expect(await runCallsSync()).toMatchObject({
      zoomReports: { "Zoom call": 3 },
      orphanServers: { discord: "Discord server list failed (500)" },
    });
  });
});
