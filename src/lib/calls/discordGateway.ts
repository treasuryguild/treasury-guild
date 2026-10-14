// Discord only says who is in a voice channel over its gateway websocket, and
// this app has no long-running process. So capture connects for a moment:
// IDENTIFY with the GUILDS and GUILD_VOICE_STATES intents (neither privileged),
// read the GUILD_CREATE the gateway sends for each server the bot is in, and
// hang up. One connection serves every server a run needs: IDENTIFY is rate
// limited per bot, so callers batch and never connect per call.
//
// Uses the runtime's global WebSocket (Node 22+, pinned in netlify.toml).
import "server-only";

import { UpstreamError } from "@/lib/errors";
import type { GatewayGuild } from "./discordSnapshot";

const GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
/** GUILDS (1 << 0) | GUILD_VOICE_STATES (1 << 7). */
const INTENTS = (1 << 0) | (1 << 7);
/** Well inside a serverless request's budget. */
const DEFAULT_DEADLINE_MS = 7000;

const OP = { Dispatch: 0, Heartbeat: 1, Identify: 2, InvalidSession: 9, Hello: 10 } as const;

const CLOSE_REASONS: Record<number, string> = {
  4004: "Discord rejected the bot token",
  4013: "Discord rejected the gateway intents",
  4014: "The bot is not allowed the requested gateway intents",
};

/** The slice of WebSocket the client needs; tests pass a fake. */
export interface GatewaySocket {
  send(data: string): void;
  close(code?: number): void;
  addEventListener(type: "message", listener: (event: { data: unknown }) => void): void;
  addEventListener(type: "close", listener: (event: { code: number }) => void): void;
  addEventListener(type: "error", listener: () => void): void;
}

export interface GuildStatesResult {
  /** State of each wanted server the bot is in. */
  guilds: Map<string, GatewayGuild>;
  /** Wanted servers the bot is not (or no longer) a member of. */
  missing: string[];
}

interface GatewayMessage {
  op: number;
  t?: string | null;
  s?: number | null;
  d?: unknown;
}

/**
 * The current state of the wanted servers. Resolves as soon as every wanted
 * server has answered; at the deadline it resolves with what arrived (a
 * server that did not is simply absent from both lists).
 */
export function fetchGuildStates(args: {
  token: string;
  guildIds: readonly string[];
  deadlineMs?: number;
  connect?: (url: string) => GatewaySocket;
}): Promise<GuildStatesResult> {
  const wanted = new Set(args.guildIds);
  const guilds = new Map<string, GatewayGuild>();
  let missing: string[] = [];
  if (wanted.size === 0) return Promise.resolve({ guilds, missing });

  const connect = args.connect ?? ((url: string) => new WebSocket(url) as unknown as GatewaySocket);

  return new Promise((resolve, reject) => {
    const socket = connect(GATEWAY_URL);
    let settled = false;
    let sequence: number | null = null;
    /** Wanted servers READY announced; null until READY. */
    let pending: Set<string> | null = null;

    const finish = (error?: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try {
        socket.close(1000);
      } catch {
        // already closed
      }
      if (error) reject(error);
      else resolve({ guilds, missing });
    };
    const timer = setTimeout(
      // Nothing at all by the deadline is a failure; a partial answer is not.
      () => finish(pending === null ? new UpstreamError("Discord gateway did not answer in time") : undefined),
      args.deadlineMs ?? DEFAULT_DEADLINE_MS,
    );

    socket.addEventListener("message", (event) => {
      let message: GatewayMessage;
      try {
        message = JSON.parse(String(event.data)) as GatewayMessage;
      } catch {
        return;
      }
      if (typeof message.s === "number") sequence = message.s;

      if (message.op === OP.Hello) {
        socket.send(JSON.stringify({
          op: OP.Identify,
          d: {
            token: args.token,
            intents: INTENTS,
            properties: { os: "linux", browser: "guild-vault", device: "guild-vault" },
          },
        }));
      } else if (message.op === OP.Heartbeat) {
        socket.send(JSON.stringify({ op: OP.Heartbeat, d: sequence }));
      } else if (message.op === OP.InvalidSession) {
        finish(new UpstreamError("Discord refused the gateway session (try again in a few seconds)"));
      } else if (message.op === OP.Dispatch && message.t === "READY") {
        const ready = message.d as { guilds?: { id: string }[] };
        const member = new Set((ready.guilds ?? []).map((g) => g.id));
        missing = [...wanted].filter((id) => !member.has(id));
        pending = new Set([...wanted].filter((id) => member.has(id)));
        if (pending.size === 0) finish();
      } else if (message.op === OP.Dispatch && message.t === "GUILD_CREATE") {
        const guild = message.d as GatewayGuild;
        if (!wanted.has(guild.id)) return;
        guilds.set(guild.id, guild);
        pending?.delete(guild.id);
        if (pending?.size === 0) finish();
      }
    });
    socket.addEventListener("close", (event) => {
      finish(new UpstreamError(CLOSE_REASONS[event.code] ?? `Discord gateway closed (${event.code})`));
    });
    socket.addEventListener("error", () => finish(new UpstreamError("Discord gateway connection failed")));
  });
}
