// Discord REST calls made as the bot (call capture). Presence itself comes
// from the gateway (src/lib/calls/discordGateway.ts); REST covers the rest:
// which voice channels a server has, and leaving a server.
import "server-only";

import { discordBotToken } from "@/lib/env.server";
import { UpstreamError } from "@/lib/errors";

const API = "https://discord.com/api/v10";
/** Channel types people hold calls in: voice and stage. */
const VOICE_CHANNEL_TYPES = new Set([2, 13]);

async function botFetch(path: string, init: RequestInit = {}): Promise<Response> {
  return fetch(`${API}${path}`, {
    ...init,
    headers: { Authorization: `Bot ${discordBotToken()}`, ...init.headers },
  });
}

export interface VoiceChannel {
  id: string;
  name: string;
}

/**
 * The server's voice and stage channels in Discord's order, or null when the
 * bot is not in the server (removed by an admin). Channels the bot cannot
 * view are not listed by Discord.
 */
export async function listVoiceChannels(guildId: string): Promise<VoiceChannel[] | null> {
  const res = await botFetch(`/guilds/${guildId}/channels`);
  if (res.status === 403 || res.status === 404) return null;
  if (!res.ok) throw new UpstreamError(`Discord channel list failed (${res.status})`);
  const channels = (await res.json()) as { id: string; name: string; type: number; position?: number }[];
  return channels
    .filter((c) => VOICE_CHANNEL_TYPES.has(c.type))
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((c) => ({ id: c.id, name: c.name }));
}

/** Every server the bot is in (Discord pages them 200 at a time, by id). */
export async function listBotGuilds(): Promise<string[]> {
  const ids: string[] = [];
  let after = "0";
  for (;;) {
    const res = await botFetch(`/users/@me/guilds?limit=200&after=${after}`);
    if (!res.ok) throw new UpstreamError(`Discord server list failed (${res.status})`);
    const page = (await res.json()) as { id: string }[];
    ids.push(...page.map((g) => g.id));
    if (page.length < 200) return ids;
    after = page[page.length - 1]!.id;
  }
}

/** The bot's own user id. */
export async function botUserId(): Promise<string> {
  const res = await botFetch("/users/@me");
  if (!res.ok) throw new UpstreamError(`Discord bot lookup failed (${res.status})`);
  return ((await res.json()) as { id: string }).id;
}

/** When the bot joined a server, or null when it is not (or no longer) in it. */
export async function botJoinedAt(guildId: string, botId: string): Promise<string | null> {
  const res = await botFetch(`/guilds/${guildId}/members/${botId}`);
  if (res.status === 403 || res.status === 404) return null;
  if (!res.ok) throw new UpstreamError(`Discord member lookup failed (${res.status})`);
  return ((await res.json()) as { joined_at: string }).joined_at;
}

/** Take the bot out of a server. Already gone counts as done. */
export async function leaveGuild(guildId: string): Promise<void> {
  const res = await botFetch(`/users/@me/guilds/${guildId}`, { method: "DELETE" });
  if (!res.ok && res.status !== 404 && res.status !== 403) {
    throw new UpstreamError(`Discord leave server failed (${res.status})`);
  }
}
