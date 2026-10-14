// Discord voice capture: a snapshot records who is in a call's voice channel
// right now. A manager can take one from the call page; the calls-sync cron
// takes one for every running Discord call. Either way a run opens ONE
// gateway connection for all the servers it needs (IDENTIFY is rate limited
// per bot) and works through a bounded batch, so it fits a serverless request.
import "server-only";

import { CallProvider, IntegrationProvider } from "@/lib/constants";
import {
  accountConnectedElsewhere, latestSnapshotAt, loadConnectedDiscordGuilds, loadDiscordGuilds, loadIntegration, loadRunningCalls, recordSnapshot,
  type CapturableCall, type SnapshotResult,
} from "@/lib/db/callCapture";
import { botJoinedAt, botUserId, leaveGuild, listBotGuilds, listVoiceChannels } from "@/lib/discord/bot";
import { discordBotToken, isProduction } from "@/lib/env.server";
import { enforceRateLimit } from "@/lib/db/rateLimit";
import { BadRequestError, ConflictError, errorMessage, TooManyRequestsError } from "@/lib/errors";
import { fetchGuildStates } from "./discordGateway";
import { presentInChannel } from "./discordSnapshot";
import { sweepMeetCalls } from "./meetCapture";
import { normalizeMeetCode } from "./meetSessions";
import { sweepZoomReports } from "./zoomCapture";

/** A manual snapshot this soon after the last one adds nothing but gateway load. */
export const MIN_SNAPSHOT_GAP_MS = 30_000;
const SNAPSHOT_TOO_SOON = "A snapshot was taken a few seconds ago. Try again in half a minute.";
/** Running calls captured per cron run. */
const BATCH = 20;

const BOT_GONE = "The bot is no longer in the Discord server. Connect the server again in Call capture settings.";

/** A call's voice channel must be one of the connected server's, visible to the bot. */
export async function assertVoiceChannel(communityId: string, channelId: string): Promise<void> {
  const guildId = (await loadDiscordGuilds([communityId])).get(communityId);
  if (!guildId) throw new BadRequestError("Connect the community's Discord server first");
  const channels = await listVoiceChannels(guildId);
  if (!channels) throw new ConflictError(BOT_GONE);
  if (!channels.some((c) => c.id === channelId)) {
    throw new BadRequestError("That voice channel is not in the connected server, or the bot cannot see it");
  }
}

/**
 * What a call is captured from must make sense for its platform: a voice
 * channel of the connected Discord server, a meeting id of the connected Zoom
 * account, or a meeting code of the connected Google account. Other
 * platforms are not captured.
 */
export async function assertCaptureRef(
  communityId: string,
  provider: CallProvider,
  ref: string,
): Promise<void> {
  if (provider === CallProvider.Discord) return assertVoiceChannel(communityId, ref);
  if (provider === CallProvider.Zoom) {
    if (!/^\d{9,11}$/.test(ref)) throw new BadRequestError("A Zoom meeting ID has 9 to 11 digits");
    if (!(await loadIntegration(communityId, IntegrationProvider.Zoom))) {
      throw new BadRequestError("Connect the community's Zoom account first");
    }
    return;
  }
  if (provider === CallProvider.Meet) {
    if (normalizeMeetCode(ref) !== ref) throw new BadRequestError("A Meet code looks like abc-mnop-xyz");
    if (!(await loadIntegration(communityId, IntegrationProvider.Google))) {
      throw new BadRequestError("Connect the Google account that organises the community's meetings first");
    }
    return;
  }
  throw new BadRequestError("Only Discord, Zoom and Google Meet calls are captured");
}

/** Take one snapshot of a running Discord call, now (a manager pressed the button). */
export async function captureCallNow(call: CapturableCall): Promise<SnapshotResult> {
  if (!call.external_ref) throw new BadRequestError("Choose the call's voice channel first");
  const guildId = (await loadDiscordGuilds([call.community_id])).get(call.community_id);
  if (!guildId) throw new BadRequestError("Connect the community's Discord server first");

  const last = await latestSnapshotAt(call.id);
  if (last && Date.now() - Date.parse(last) < MIN_SNAPSHOT_GAP_MS) throw new ConflictError(SNAPSHOT_TOO_SOON);
  // The check above reads a snapshot that may not exist yet: two clicks at
  // once both pass it. The counter is one atomic step, so only one connects.
  try {
    await enforceRateLimit("callCapture", call.id);
  } catch (err) {
    if (err instanceof TooManyRequestsError) throw new ConflictError(SNAPSHOT_TOO_SOON);
    throw err;
  }
  const { guilds, missing } = await fetchGuildStates({ token: discordBotToken(), guildIds: [guildId] });
  if (missing.includes(guildId)) throw new ConflictError(BOT_GONE);
  const guild = guilds.get(guildId);
  if (!guild) throw new ConflictError("Discord did not send the server's state in time. Try again.");
  return recordSnapshot(call.id, "manual", presentInChannel(guild, call.external_ref));
}

// A type alias, not an interface, so the route wrapper's JSON type accepts it.
export type CallsSyncResult = {
  /** Running Discord calls found. */
  calls: number;
  /** Snapshots recorded. */
  snapshots: number;
  /** Per call title: people present, or why it was skipped. */
  results: Record<string, number | string>;
  /** Ended Zoom calls whose participant report was due: sessions recorded, or why not. */
  zoomReports: Record<string, number | string>;
  /** Running and just-ended Meet calls: sessions recorded, or why not. */
  meetCalls: Record<string, number | string>;
  /** Servers the bot is in that no community is connected to: left, or why not. */
  orphanServers: Record<string, string>;
};

type DiscordResult = Pick<CallsSyncResult, "calls" | "snapshots" | "results">;

/**
 * The calls-sync cron: one snapshot for every running Discord call, the
 * participant reports of Zoom calls that ended, and the conference records of
 * running and just-ended Meet calls. The three are independent: an outage of
 * one platform must not hold back the others.
 */
export async function runCallsSync(): Promise<CallsSyncResult> {
  const now = new Date();
  const guarded = async <T>(task: () => Promise<T>, onError: (message: string) => T): Promise<T> => {
    try {
      return await task();
    } catch (err) {
      return onError(errorMessage(err, "run failed"));
    }
  };
  const [discord, zoomReports, meetCalls, orphanServers] = await Promise.all([
    guarded<DiscordResult>(() => snapshotRunningDiscordCalls(now), (m) => ({ calls: 0, snapshots: 0, results: { discord: m } })),
    guarded(() => sweepZoomReports(now), (m) => ({ zoom: m })),
    guarded(() => sweepMeetCalls(now), (m) => ({ meet: m })),
    guarded(() => leaveOrphanGuilds(now), (m) => ({ discord: m })),
  ]);
  return { ...discord, zoomReports, meetCalls, orphanServers };
}

/** A server the bot joined this recently may be a connection still in progress. */
export const ORPHAN_GUILD_GRACE_MS = 60 * 60 * 1000;
/** Member lookups (and leaves) per run; the rest wait for the next run. */
const ORPHAN_GUILD_BATCH = 10;

/**
 * Take the bot out of servers no community is connected to: an admin who
 * approved the bot on Discord and never came back to the callback (tab
 * closed) leaves it there, and nothing else would ever notice. Production
 * only: this database is then the one that knows every connection, whereas a
 * local stack sharing the bot would see production's servers as orphans. A
 * server the bot joined within the hour is left alone (a connection may be
 * finishing).
 */
export async function leaveOrphanGuilds(now: Date): Promise<Record<string, string>> {
  if (!isProduction()) return { skipped: "outside production" };
  const [inGuilds, connected] = await Promise.all([listBotGuilds(), loadConnectedDiscordGuilds()]);
  const orphans = inGuilds.filter((id) => !connected.has(id)).slice(0, ORPHAN_GUILD_BATCH);
  const result: Record<string, string> = {};
  if (orphans.length === 0) return result;
  const botId = await botUserId();
  for (const guildId of orphans) {
    try {
      const joinedAt = await botJoinedAt(guildId, botId);
      if (!joinedAt) result[guildId] = "bot already gone";
      else if (now.getTime() - Date.parse(joinedAt) < ORPHAN_GUILD_GRACE_MS) result[guildId] = "joined within the hour";
      // Read again just before leaving: an admin may have connected it since.
      else if (await accountConnectedElsewhere(IntegrationProvider.Discord, guildId)) result[guildId] = "connected meanwhile";
      else {
        await leaveGuild(guildId);
        result[guildId] = "left";
      }
    } catch (err) {
      result[guildId] = errorMessage(err, "failed");
    }
  }
  return result;
}

async function snapshotRunningDiscordCalls(now: Date): Promise<DiscordResult> {
  const calls = await loadRunningCalls(CallProvider.Discord, now, BATCH);
  const result: DiscordResult = { calls: calls.length, snapshots: 0, results: {} };
  if (calls.length === 0) return result;

  const guildByCommunity = await loadDiscordGuilds([...new Set(calls.map((c) => c.community_id))]);
  const { guilds, missing } = await fetchGuildStates({
    token: discordBotToken(),
    guildIds: [...new Set(guildByCommunity.values())],
  });

  for (const call of calls) {
    const label = `${call.title} (${call.id.slice(0, 8)})`;
    const guildId = guildByCommunity.get(call.community_id);
    const guild = guildId ? guilds.get(guildId) : undefined;
    if (!guildId) result.results[label] = "no Discord server connected";
    else if (missing.includes(guildId)) result.results[label] = "bot is not in the server";
    else if (!guild || !call.external_ref) result.results[label] = "no server state in time";
    else {
      try {
        const snapshot = await recordSnapshot(call.id, "cron", presentInChannel(guild, call.external_ref));
        result.snapshots += 1;
        result.results[label] = snapshot.present;
      } catch (err) {
        result.results[label] = errorMessage(err, "snapshot failed");
      }
    }
  }
  return result;
}
