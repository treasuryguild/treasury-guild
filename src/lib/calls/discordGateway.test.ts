import { describe, expect, it } from "vitest";
import { fetchGuildStates, type GatewaySocket } from "./discordGateway";

type Listener = (event: never) => void;

/** A scripted gateway: records what the client sends, lets the test push frames. */
class FakeSocket implements GatewaySocket {
  sent: { op: number; d: unknown }[] = [];
  closedWith: number | undefined;
  private listeners: Record<string, Listener[]> = {};

  send(data: string) {
    this.sent.push(JSON.parse(data) as { op: number; d: unknown });
  }
  close(code?: number) {
    this.closedWith = code;
  }
  addEventListener(type: string, listener: Listener) {
    (this.listeners[type] ??= []).push(listener);
  }
  push(frame: unknown) {
    for (const l of this.listeners.message ?? []) l({ data: JSON.stringify(frame) } as never);
  }
  emitClose(code: number) {
    for (const l of this.listeners.close ?? []) l({ code } as never);
  }
}

function start(guildIds: string[], deadlineMs = 1000) {
  const socket = new FakeSocket();
  const result = fetchGuildStates({ token: "bot-token", guildIds, deadlineMs, connect: () => socket });
  return { socket, result };
}

describe("fetchGuildStates", () => {
  it("identifies with the two unprivileged intents and collects the wanted servers", async () => {
    const { socket, result } = start(["g1", "g2", "gone"]);
    socket.push({ op: 10, d: { heartbeat_interval: 41250 } });
    expect(socket.sent[0]).toMatchObject({ op: 2, d: { token: "bot-token", intents: 129 } });

    socket.push({ op: 0, t: "READY", s: 1, d: { guilds: [{ id: "g1" }, { id: "g2" }, { id: "other" }] } });
    socket.push({ op: 0, t: "GUILD_CREATE", s: 2, d: { id: "other", voice_states: [] } });
    socket.push({ op: 0, t: "GUILD_CREATE", s: 3, d: { id: "g2", voice_states: [{ user_id: "9", channel_id: "c" }] } });
    expect(socket.closedWith).toBeUndefined();
    socket.push({ op: 0, t: "GUILD_CREATE", s: 4, d: { id: "g1", voice_states: [] } });

    const { guilds, missing } = await result;
    expect([...guilds.keys()].sort()).toEqual(["g1", "g2"]);
    expect(guilds.get("g2")?.voice_states).toEqual([{ user_id: "9", channel_id: "c" }]);
    expect(missing).toEqual(["gone"]);
    expect(socket.closedWith).toBe(1000);
  });

  it("answers a heartbeat request with the last sequence", async () => {
    const { socket, result } = start(["g1"]);
    socket.push({ op: 10, d: {} });
    socket.push({ op: 0, t: "READY", s: 7, d: { guilds: [{ id: "g1" }] } });
    socket.push({ op: 1 });
    expect(socket.sent[1]).toEqual({ op: 1, d: 7 });
    socket.push({ op: 0, t: "GUILD_CREATE", s: 8, d: { id: "g1" } });
    await result;
  });

  it("finishes at once when the bot is in none of the wanted servers", async () => {
    const { socket, result } = start(["g1"]);
    socket.push({ op: 10, d: {} });
    socket.push({ op: 0, t: "READY", s: 1, d: { guilds: [] } });
    await expect(result).resolves.toMatchObject({ missing: ["g1"] });
  });

  it("connects to nothing when nothing is wanted", async () => {
    let connected = false;
    const result = await fetchGuildStates({
      token: "t", guildIds: [], connect: () => { connected = true; return new FakeSocket(); },
    });
    expect(connected).toBe(false);
    expect(result.guilds.size).toBe(0);
  });

  it("returns what arrived at the deadline, but fails when nothing did", async () => {
    const partial = start(["g1", "g2"], 20);
    partial.socket.push({ op: 10, d: {} });
    partial.socket.push({ op: 0, t: "READY", s: 1, d: { guilds: [{ id: "g1" }, { id: "g2" }] } });
    partial.socket.push({ op: 0, t: "GUILD_CREATE", s: 2, d: { id: "g1" } });
    expect([...(await partial.result).guilds.keys()]).toEqual(["g1"]);

    await expect(start(["g1"], 20).result).rejects.toThrow(/did not answer in time/);
  });

  it("explains a rejected token, a refused session and a dropped connection", async () => {
    const badToken = start(["g1"]);
    badToken.socket.emitClose(4004);
    await expect(badToken.result).rejects.toThrow(/rejected the bot token/);

    const invalid = start(["g1"]);
    invalid.socket.push({ op: 9, d: false });
    await expect(invalid.result).rejects.toThrow(/refused the gateway session/);

    const dropped = start(["g1"]);
    dropped.socket.emitClose(1006);
    await expect(dropped.result).rejects.toThrow(/closed \(1006\)/);
  });
});
