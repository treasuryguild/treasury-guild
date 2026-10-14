import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UpstreamError } from "@/lib/errors";

vi.mock("@/lib/env.server", () => ({ discordBotToken: () => "bot-token" }));

import { botJoinedAt, botUserId, leaveGuild, listBotGuilds, listVoiceChannels } from "./bot";

const API = "https://discord.com/api/v10";
const fetchMock = vi.fn();
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
const status = (code: number) => new Response(null, { status: code });
const guilds = (from: number, count: number) => Array.from({ length: count }, (_, i) => ({ id: String(from + i) }));

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal("fetch", fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("listBotGuilds", () => {
  it("reads one page when Discord returns fewer than 200 servers", async () => {
    fetchMock.mockResolvedValueOnce(json(guilds(1, 3)));
    expect(await listBotGuilds()).toEqual(["1", "2", "3"]);
    expect(fetchMock).toHaveBeenCalledExactlyOnceWith(`${API}/users/@me/guilds?limit=200&after=0`, {
      headers: { Authorization: "Bot bot-token" },
    });
  });

  it("pages 200 at a time after the last id until a short page", async () => {
    fetchMock.mockResolvedValueOnce(json(guilds(1, 200))).mockResolvedValueOnce(json(guilds(201, 200))).mockResolvedValueOnce(json([]));
    const ids = await listBotGuilds();
    expect(ids).toHaveLength(400);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      `${API}/users/@me/guilds?limit=200&after=0`,
      `${API}/users/@me/guilds?limit=200&after=200`,
      `${API}/users/@me/guilds?limit=200&after=400`,
    ]);
  });

  it("throws when Discord refuses, rather than answering a partial list", async () => {
    fetchMock.mockResolvedValueOnce(json(guilds(1, 200))).mockResolvedValueOnce(status(500));
    await expect(listBotGuilds()).rejects.toThrow(new UpstreamError("Discord server list failed (500)"));
  });
});

describe("botUserId", () => {
  it("returns the bot's own id", async () => {
    fetchMock.mockResolvedValueOnce(json({ id: "bot-1", username: "Treasury Guild" }));
    expect(await botUserId()).toBe("bot-1");
    expect(fetchMock).toHaveBeenCalledWith(`${API}/users/@me`, expect.anything());
  });

  it("throws when the lookup fails", async () => {
    fetchMock.mockResolvedValueOnce(status(401));
    await expect(botUserId()).rejects.toThrow(UpstreamError);
  });
});

describe("botJoinedAt", () => {
  it("returns when the bot joined the server", async () => {
    fetchMock.mockResolvedValueOnce(json({ joined_at: "2026-10-01T10:00:00.000Z" }));
    expect(await botJoinedAt("g-1", "bot-1")).toBe("2026-10-01T10:00:00.000Z");
    expect(fetchMock).toHaveBeenCalledWith(`${API}/guilds/g-1/members/bot-1`, expect.anything());
  });

  it("answers null when the bot is not (or no longer) in the server", async () => {
    fetchMock.mockResolvedValueOnce(status(404)).mockResolvedValueOnce(status(403));
    expect(await botJoinedAt("g-1", "bot-1")).toBeNull();
    expect(await botJoinedAt("g-1", "bot-1")).toBeNull();
  });

  it("throws on any other failure, so the server is not taken for an orphan", async () => {
    fetchMock.mockResolvedValueOnce(status(502));
    await expect(botJoinedAt("g-1", "bot-1")).rejects.toThrow(UpstreamError);
  });
});

describe("leaveGuild", () => {
  it("leaves the server, and counts already gone as done", async () => {
    fetchMock.mockResolvedValueOnce(status(204)).mockResolvedValueOnce(status(404)).mockResolvedValueOnce(status(403));
    await leaveGuild("g-1");
    await leaveGuild("g-1");
    await leaveGuild("g-1");
    expect(fetchMock).toHaveBeenCalledWith(`${API}/users/@me/guilds/g-1`, expect.objectContaining({ method: "DELETE" }));
  });

  it("throws on any other failure", async () => {
    fetchMock.mockResolvedValueOnce(status(500));
    await expect(leaveGuild("g-1")).rejects.toThrow(UpstreamError);
  });
});

describe("listVoiceChannels", () => {
  it("lists voice and stage channels in Discord's order", async () => {
    fetchMock.mockResolvedValueOnce(json([
      { id: "t", name: "general", type: 0, position: 0 },
      { id: "s", name: "Stage", type: 13, position: 2 },
      { id: "v", name: "Voice", type: 2, position: 1 },
    ]));
    expect(await listVoiceChannels("g-1")).toEqual([{ id: "v", name: "Voice" }, { id: "s", name: "Stage" }]);
  });

  it("answers null when the bot is not in the server", async () => {
    fetchMock.mockResolvedValueOnce(status(404));
    expect(await listVoiceChannels("g-1")).toBeNull();
  });
});
