// Discord REST calls made as the bot. Presence for call capture comes from
// the gateway (src/lib/calls/discordGateway.ts); REST covers voice-channel
// lists, leaving a server, and governance posts (messages, forum posts,
// public threads).
import "server-only";

import { discordBotToken } from "@/lib/env.server";
import { errorMessage, UpstreamError } from "@/lib/errors";
import type { DiscordWebhookPayload } from "./payoutMessage";

const API = "https://discord.com/api/v10";
/** Channel types people hold calls in: voice and stage. */
const VOICE_CHANNEL_TYPES = new Set([2, 13]);
/** Text, announcement, and forum — where governance messages can land. */
const TEXT_LIKE_CHANNEL_TYPES = new Set([0, 5, 15]);
const BODY_EXCERPT = 200;

export type BotFetchLike = (url: string, init: RequestInit) => Promise<Response>;

/**
 * `permanent` = retrying the same request will not help (bot removed, missing
 * channel/permissions → 401/403/404, payload rejected → other 4xx). Transient
 * failures (429, 5xx, network) are left for the next cron sweep.
 */
export class DiscordBotError extends Error {
  constructor(
    message: string,
    public readonly status: number | null,
    public readonly permanent: boolean,
  ) {
    super(message);
    this.name = "DiscordBotError";
  }
}

async function botFetch(
  path: string,
  init: RequestInit = {},
  fetchImpl: BotFetchLike = (u, i) => fetch(u, i),
): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bot ${discordBotToken()}`);
  if (init.body && !headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return fetchImpl(`${API}${path}`, { ...init, headers });
}

function throwBotError(res: Response, excerpt: string, missingLabel: string): never {
  const permanent = res.status >= 400 && res.status < 500 && res.status !== 429;
  const what =
    res.status === 401 || res.status === 403 || res.status === 404
      ? missingLabel
      : `Discord answered ${res.status}`;
  throw new DiscordBotError(excerpt ? `${what}: ${excerpt}` : what, res.status, permanent);
}

async function readExcerpt(res: Response): Promise<string> {
  return (await res.text().catch(() => "")).slice(0, BODY_EXCERPT);
}

export interface VoiceChannel {
  id: string;
  name: string;
}

export interface TextLikeChannel {
  id: string;
  name: string;
  /** Discord channel type: 0 text, 5 announcement, 15 forum. */
  type: number;
}

/**
 * The server's voice and stage channels in Discord's order, or null when the
 * bot is not in the server (removed by an admin). Channels the bot cannot
 * view are not listed by Discord.
 */
export async function listVoiceChannels(
  guildId: string,
  fetchImpl?: BotFetchLike,
): Promise<VoiceChannel[] | null> {
  const res = await botFetch(`/guilds/${guildId}/channels`, {}, fetchImpl);
  if (res.status === 403 || res.status === 404) return null;
  if (!res.ok) throw new UpstreamError(`Discord channel list failed (${res.status})`);
  const channels = (await res.json()) as { id: string; name: string; type: number; position?: number }[];
  return channels
    .filter((c) => VOICE_CHANNEL_TYPES.has(c.type))
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((c) => ({ id: c.id, name: c.name }));
}

/**
 * Text, announcement and forum channels the bot can see, or null when it is
 * not in the server. Used to pick a governance channel.
 */
export async function listTextLikeChannels(
  guildId: string,
  fetchImpl?: BotFetchLike,
): Promise<TextLikeChannel[] | null> {
  const res = await botFetch(`/guilds/${guildId}/channels`, {}, fetchImpl);
  if (res.status === 403 || res.status === 404) return null;
  if (!res.ok) throw new UpstreamError(`Discord channel list failed (${res.status})`);
  const channels = (await res.json()) as { id: string; name: string; type: number; position?: number }[];
  return channels
    .filter((c) => TEXT_LIKE_CHANNEL_TYPES.has(c.type))
    .sort((a, b) => (a.position ?? 0) - (b.position ?? 0))
    .map((c) => ({ id: c.id, name: c.name, type: c.type }));
}

/** Every server the bot is in (Discord pages them 200 at a time, by id). */
export async function listBotGuilds(fetchImpl?: BotFetchLike): Promise<string[]> {
  const ids: string[] = [];
  let after = "0";
  for (;;) {
    const res = await botFetch(`/users/@me/guilds?limit=200&after=${after}`, {}, fetchImpl);
    if (!res.ok) throw new UpstreamError(`Discord server list failed (${res.status})`);
    const page = (await res.json()) as { id: string }[];
    ids.push(...page.map((g) => g.id));
    if (page.length < 200) return ids;
    after = page[page.length - 1]!.id;
  }
}

/** The bot's own user id. */
export async function botUserId(fetchImpl?: BotFetchLike): Promise<string> {
  const res = await botFetch("/users/@me", {}, fetchImpl);
  if (!res.ok) throw new UpstreamError(`Discord bot lookup failed (${res.status})`);
  return ((await res.json()) as { id: string }).id;
}

/** When the bot joined a server, or null when it is not (or no longer) in it. */
export async function botJoinedAt(
  guildId: string,
  botId: string,
  fetchImpl?: BotFetchLike,
): Promise<string | null> {
  const res = await botFetch(`/guilds/${guildId}/members/${botId}`, {}, fetchImpl);
  if (res.status === 403 || res.status === 404) return null;
  if (!res.ok) throw new UpstreamError(`Discord member lookup failed (${res.status})`);
  return ((await res.json()) as { joined_at: string }).joined_at;
}

/** Take the bot out of a server. Already gone counts as done. */
export async function leaveGuild(guildId: string, fetchImpl?: BotFetchLike): Promise<void> {
  const res = await botFetch(`/users/@me/guilds/${guildId}`, { method: "DELETE" }, fetchImpl);
  if (!res.ok && res.status !== 404 && res.status !== 403) {
    throw new UpstreamError(`Discord leave server failed (${res.status})`);
  }
}

export interface PostedMessage {
  id: string;
  channel_id: string;
}

export interface BotMessagePayload {
  content?: string;
  embeds?: DiscordWebhookPayload["embeds"];
}

/** Post a message (embeds) to a text or announcement channel, or into a thread. */
export async function postChannelMessage(
  channelId: string,
  payload: BotMessagePayload,
  fetchImpl?: BotFetchLike,
): Promise<PostedMessage> {
  let res: Response;
  try {
    res = await botFetch(`/channels/${channelId}/messages`, {
      method: "POST",
      body: JSON.stringify({
        content: payload.content,
        embeds: payload.embeds,
        allowed_mentions: { parse: [] },
      }),
    }, fetchImpl);
  } catch (err) {
    throw new DiscordBotError(`Discord unreachable: ${errorMessage(err)}`, null, false);
  }
  if (!res.ok) {
    throwBotError(res, await readExcerpt(res), "Discord channel missing or bot lacks permission");
  }
  const body = (await res.json()) as PostedMessage;
  return { id: body.id, channel_id: body.channel_id };
}

/**
 * Start a public (or announcement) thread from an existing message. The
 * thread id equals the source message id.
 */
export async function startThreadFromMessage(
  channelId: string,
  messageId: string,
  name: string,
  fetchImpl?: BotFetchLike,
): Promise<{ id: string }> {
  let res: Response;
  try {
    res = await botFetch(`/channels/${channelId}/messages/${messageId}/threads`, {
      method: "POST",
      body: JSON.stringify({ name: name.slice(0, 100) }),
    }, fetchImpl);
  } catch (err) {
    throw new DiscordBotError(`Discord unreachable: ${errorMessage(err)}`, null, false);
  }
  if (!res.ok) {
    throwBotError(res, await readExcerpt(res), "Discord channel missing or bot lacks permission");
  }
  const body = (await res.json()) as { id: string };
  return { id: body.id };
}

/**
 * Create a forum post (thread + starter message). Returns the thread id
 * (same as the starter message id).
 */
export async function createForumPost(
  channelId: string,
  input: { name: string; content?: string; embeds?: DiscordWebhookPayload["embeds"] },
  fetchImpl?: BotFetchLike,
): Promise<{ id: string }> {
  let res: Response;
  try {
    res = await botFetch(`/channels/${channelId}/threads`, {
      method: "POST",
      body: JSON.stringify({
        name: input.name.slice(0, 100),
        message: {
          content: input.content,
          embeds: input.embeds,
          allowed_mentions: { parse: [] },
        },
      }),
    }, fetchImpl);
  } catch (err) {
    throw new DiscordBotError(`Discord unreachable: ${errorMessage(err)}`, null, false);
  }
  if (!res.ok) {
    throwBotError(res, await readExcerpt(res), "Discord channel missing or bot lacks permission");
  }
  const body = (await res.json()) as { id: string };
  return { id: body.id };
}
