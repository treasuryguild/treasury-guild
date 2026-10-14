// Google Meet capture. Meet pushes nothing, so the calls-sync cron polls: a
// running Meet call is read every run (a conference record lists its
// participants while it is still going), and an ended call is read once more
// for the final times. Every read records the same participant sessions under
// the same keys, so repeating it only fills in end times (migration 0040).
import "server-only";

import { CallProvider, IdentityProvider, IntegrationProvider } from "@/lib/constants";
import {
  insertLinkedCall, loadActiveMeetingLinks, loadCallsAwaitingReport, loadIntegration, loadKnownInstances,
  loadRunningCalls, markCallCaptured, recordSessions, setCallEnd,
  type ReportableCall,
} from "@/lib/db/callCapture";
import { loadNameMatchContext } from "@/lib/db/calls";
import { loadWalletsByIdentity } from "@/lib/db/identities";
import { errorMessage } from "@/lib/errors";
import { meetClient } from "./meetApi";
import {
  followedEnd, linkedOccurrence, meetAccountId, pickConferenceRecord, sessionsFromMeetParticipant,
  type MeetParticipantSession,
} from "./meetSessions";

/** Meet calls read per cron run: a handful of API round trips each. */
const BATCH = 5;
/** Linked codes checked for a new conference per cron run: one request each. */
const LINK_BATCH = 20;
/** Participants whose individual stays are fetched; beyond that their first-to-last span stands in. */
const MAX_STAY_LOOKUPS = 120;
const CONCURRENCY = 8;
/** An ended call whose conference still runs is re-read until this long after its end. */
const OVERRUN_GIVE_UP_MS = 2 * 60 * 60 * 1000;

async function inBatches<T, R>(items: readonly T[], size: number, task: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = [];
  for (let i = 0; i < items.length; i += size) {
    out.push(...(await Promise.all(items.slice(i, i + size).map(task))));
  }
  return out;
}

/** Read one call's conference. Returns the sessions recorded, or a reason nothing was. */
async function captureMeetCall(call: ReportableCall, final: boolean, now: Date): Promise<number | string> {
  const integration = await loadIntegration(call.community_id, IntegrationProvider.Google);
  if (!integration || !call.external_ref) return "no Google account connected";

  const meet = await meetClient(integration.id);
  const records = await meet.conferenceRecords(call.external_ref);
  // A call that created itself names its conference; a hand-made one is matched by time.
  const record = call.external_instance
    ? records.find((r) => r.name === call.external_instance) ?? null
    : pickConferenceRecord(records, call);
  if (!record) {
    // Nobody opened the room (yet), or the connected account does not own it.
    return "no conference under this code at the call's time";
  }

  // Only a call that created itself follows the meeting, and before the
  // sessions are recorded: minutes are clipped to the call's times.
  let endsAt = call.ends_at;
  if (call.external_instance) {
    const moved = followedEnd(record, call, now);
    if (moved) {
      await setCallEnd(call.id, moved);
      endsAt = moved;
    }
  }

  const participants = await meet.participants(record.name);
  const stays = await inBatches(
    participants.map((p, index) => ({ name: p.name, index })),
    CONCURRENCY,
    async ({ name, index }): Promise<MeetParticipantSession[] | null> => {
      if (index >= MAX_STAY_LOOKUPS) return null;
      try {
        return await meet.participantSessions(name);
      } catch {
        // One unreadable participant must not lose the rest: their span stands in.
        return null;
      }
    },
  );

  const [names, walletsByAccount] = await Promise.all([
    loadNameMatchContext(call.community_id),
    loadWalletsByIdentity(
      IdentityProvider.Google,
      participants.map(meetAccountId).filter((id): id is string => !!id),
    ),
  ]);
  const ctx = { names, walletsByAccount };
  const sessions = participants.flatMap((p, i) => sessionsFromMeetParticipant(p, stays[i] ?? null, ctx));
  const recorded = await recordSessions(call.id, CallProvider.Meet, sessions);

  // Final once Google closed the conference, or the call ended long enough ago.
  const overrun = now.getTime() - Date.parse(endsAt) > OVERRUN_GIVE_UP_MS;
  if (final && (record.endTime || overrun)) await markCallCaptured(call.id);
  return recorded.sessions;
}

/**
 * Linked Meet codes (migration 0044): a conference of a linked code that has
 * no call yet becomes one, which the sweep below then captures like any
 * other. One conference list per link per run. Returns what it created or
 * could not read, per link.
 */
async function discoverLinkedMeetCalls(now: Date): Promise<Record<string, number | string>> {
  const results: Record<string, number | string> = {};
  const clients = new Map<string, Promise<Awaited<ReturnType<typeof meetClient>> | null>>();
  const clientFor = (communityId: string) => {
    let client = clients.get(communityId);
    if (!client) {
      client = loadIntegration(communityId, IntegrationProvider.Google).then((i) => (i ? meetClient(i.id) : null));
      clients.set(communityId, client);
    }
    return client;
  };

  for (const link of await loadActiveMeetingLinks(CallProvider.Meet, LINK_BATCH)) {
    const label = `linked: ${link.title} (${link.id.slice(0, 8)})`;
    try {
      const meet = await clientFor(link.community_id);
      if (!meet) {
        results[label] = "no Google account connected";
        continue;
      }
      const occurrences = (await meet.conferenceRecords(link.meeting_ref))
        .map((record) => linkedOccurrence(record, link, now))
        .filter((o) => o !== null);
      const known = await loadKnownInstances(link.community_id, CallProvider.Meet, occurrences.map((o) => o.instance));
      let created = 0;
      for (const occurrence of occurrences) {
        if (known.has(occurrence.instance)) continue;
        // Null: an overlapping run created it a moment ago.
        if (await insertLinkedCall(link, occurrence)) created++;
      }
      if (created > 0) results[label] = created;
    } catch (err) {
      results[label] = errorMessage(err, "discovery failed");
    }
  }
  return results;
}

/** The Meet half of calls-sync: new calls of linked codes, running calls, then ended calls not yet final. */
export async function sweepMeetCalls(now: Date): Promise<Record<string, number | string>> {
  const results: Record<string, number | string> = {};
  try {
    Object.assign(results, await discoverLinkedMeetCalls(now));
  } catch (err) {
    // Discovery must never cost the listed calls their capture.
    results.linked = errorMessage(err, "discovery failed");
  }
  const running = await loadRunningCalls(CallProvider.Meet, now, BATCH);
  const ended = await loadCallsAwaitingReport(CallProvider.Meet, now, BATCH);
  for (const [call, final] of [...running.map((c) => [c, false] as const), ...ended.map((c) => [c, true] as const)]) {
    const label = `${call.title} (${call.id.slice(0, 8)})`;
    try {
      results[label] = await captureMeetCall(call, final, now);
    } catch (err) {
      results[label] = errorMessage(err, "capture failed");
    }
  }
  return results;
}
