import { beforeEach, describe, expect, it, vi } from "vitest";
import { DiscordBotError } from "./bot";

const mocks = vi.hoisted(() => ({
  guild: vi.fn(),
  channels: vi.fn(),
  post: vi.fn(),
  save: vi.fn(),
}));
vi.mock("./governanceChannel", () => ({ loadDiscordGuild: mocks.guild }));
vi.mock("./bot", async (importOriginal) => {
  const real = await importOriginal<typeof import("./bot")>();
  return { ...real, listTextLikeChannels: mocks.channels, postChannelMessage: mocks.post };
});
vi.mock("@/lib/db/treasuries", () => ({ saveTreasuryDiscordChannel: mocks.save }));

import {
  connectTreasuryDiscordChannel,
  listTreasuryDiscordChannelOptions,
} from "./treasuryDestination";

const TREASURY = { id: "t-1", community_id: "c-1", name: "Main" };
const CHANNELS = [
  { id: "text-1", name: "payouts", type: 0 },
  { id: "announce-1", name: "announce", type: 5 },
  { id: "forum-1", name: "forum", type: 15 },
  { id: "voice-1", name: "voice", type: 2 },
];

beforeEach(() => {
  vi.resetAllMocks();
  mocks.guild.mockResolvedValue({ guildId: "guild-1" });
  mocks.channels.mockResolvedValue(CHANNELS);
  mocks.post.mockResolvedValue({ id: "m-1", channel_id: "text-1" });
  mocks.save.mockResolvedValue(undefined);
});

describe("listTreasuryDiscordChannelOptions", () => {
  it("lists only text and announcement channels", async () => {
    expect(await listTreasuryDiscordChannelOptions("c-1")).toEqual([
      { id: "text-1", name: "payouts", type: 0 },
      { id: "announce-1", name: "announce", type: 5 },
    ]);
  });

  it("answers empty when there is no Discord server or the bot is gone", async () => {
    mocks.guild.mockResolvedValue(null);
    expect(await listTreasuryDiscordChannelOptions("c-1")).toEqual([]);
    mocks.guild.mockResolvedValue({ guildId: "guild-1" });
    mocks.channels.mockResolvedValue(null);
    expect(await listTreasuryDiscordChannelOptions("c-1")).toEqual([]);
  });
});

describe("connectTreasuryDiscordChannel", () => {
  it("posts a hello, saves the destination and returns it", async () => {
    const result = await connectTreasuryDiscordChannel(TREASURY, "text-1", "addr_admin");
    expect(mocks.post).toHaveBeenCalledExactlyOnceWith(
      "text-1",
      expect.objectContaining({ embeds: expect.any(Array) }),
      undefined,
    );
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith({
      treasuryId: "t-1",
      channelId: "text-1",
      channelType: 0,
      actor: "addr_admin",
      now: result.now,
    });
    expect(result.destination).toEqual({
      treasury_id: "t-1",
      url: null,
      channel_id: "text-1",
      channel_type: 0,
      last_posted_at: result.now,
      last_error: null,
    });
  });

  it("refuses a forum channel even though listTextLikeChannels includes it", async () => {
    await expect(connectTreasuryDiscordChannel(TREASURY, "forum-1", "addr_admin"))
      .rejects.toThrow(DiscordBotError);
    expect(mocks.post).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("refuses when no Discord server is connected", async () => {
    mocks.guild.mockResolvedValue(null);
    await expect(connectTreasuryDiscordChannel(TREASURY, "text-1", "addr_admin"))
      .rejects.toThrow(/Connect a Discord server/);
  });

  it("refuses when the bot is not in the server", async () => {
    mocks.channels.mockResolvedValue(null);
    await expect(connectTreasuryDiscordChannel(TREASURY, "text-1", "addr_admin"))
      .rejects.toThrow(/not in the Discord server/);
  });
});
