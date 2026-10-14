import { describe, expect, it } from "vitest";
import { presentInChannel, type GatewayGuild } from "./discordSnapshot";

const guild: GatewayGuild = {
  id: "g1",
  voice_states: [
    { user_id: "1", channel_id: "voice-a" },
    { user_id: "2", channel_id: "voice-a" },
    { user_id: "3", channel_id: "voice-b" },
    { user_id: "4", channel_id: "voice-a" },
    { user_id: "5", channel_id: "voice-a" },
    { user_id: "1", channel_id: "voice-a" },
    { user_id: "6", channel_id: null },
  ],
  members: [
    { user: { id: "1", username: "alice", global_name: "Alice" }, nick: "Ali (core team)" },
    { user: { id: "2", username: "bob", global_name: null } },
    { user: { id: "3", username: "carol" } },
    { user: { id: "4", username: "music-bot", bot: true } },
  ],
};

describe("presentInChannel", () => {
  it("lists the people in the channel once, by their best name", () => {
    expect(presentInChannel(guild, "voice-a")).toEqual([
      { id: "1", name: "Ali (core team)" },
      { id: "2", name: "bob" },
      // Discord sent no member for this user: still present, name filled in later.
      { id: "5", name: "" },
    ]);
  });

  it("ignores other channels, bots and an empty guild", () => {
    expect(presentInChannel(guild, "voice-b")).toEqual([{ id: "3", name: "carol" }]);
    expect(presentInChannel(guild, "voice-c")).toEqual([]);
    expect(presentInChannel({ id: "g2" }, "voice-a")).toEqual([]);
  });
});
