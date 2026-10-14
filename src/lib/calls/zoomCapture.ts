// Zoom capture. Live: participant joined / left webhooks become presence
// sessions while the meeting runs. Afterwards: the calls-sync cron reads the
// meeting's participant report and records it over the same attendees, which
// repairs any event Zoom never delivered. Webhooks are not the source of
// truth (the same stance as the GitHub integration); overlapping evidence is
// harmless because minutes are the union of sessions (migration 0040).
//
// Hosts open the meeting before they create the rewarded call, so an event of
// a connected account that matches no call is parked (migration 0042) and
// replayed once a call names that meeting: on create / edit, and with the next
// live event. Unclaimed events are purged by the cron.
import "server-only";

import { CallProvider, IntegrationProvider } from "@/lib/constants";
import {
  deletePendingSessions, findCallByInstance, findCallForMeeting, findMeetingLink, insertLinkedCall,
  loadCallsAwaitingReport, loadIntegration, loadIntegrationsByAccount, loadPendingSessions, markCallCaptured,
  purgePendingSessions, purgeZoomDeliveries, recomputeCallMinutes, recordSessions, savePendingSession, setCallEnd,
  type CapturableCall,
} from "@/lib/db/callCapture";
import { loadNameMatchContext as nameContext } from "@/lib/db/calls";
import { errorMessage } from "@/lib/errors";
import { matchName, type NameMatchContext } from "./nameMatch";
import { fetchPastParticipants } from "./zoomApi";
import { sessionFromWebhook, sessionsFromReport, type ZoomWebhookParticipant } from "./zoomSessions";

/** Ended Zoom calls whose report is read per cron run. */
const REPORT_BATCH = 5;


/** A parked event has no community yet: its name is matched when it is replayed. */
const NO_NAMES: NameMatchContext = { aliases: new Map(), members: [] };

/** What the webhook says about the meeting an event belongs to. */
export interface ZoomEventMeeting {
  id: string;
  /** Zoom's uuid of this occurrence; a recurring meeting gets a new one every time. */
  uuid: string | null;
  topic: string | null;
  /** When this occurrence started. */
  startTime: string | null;
}

/** A call that created itself ends at least this long after the join that created it. */
const MIN_LINKED_CALL_MS = 5 * 60 * 1000;

/**
 * One join / leave event. The meeting belongs to whichever community
 * connected the sending account and has an open Zoom call for it: the call
 * created for this very occurrence, else one naming the meeting id around the
 * event's time. With neither, a join to a **linked** meeting creates the call
 * (migration 0043); anything else is parked for a call created later. An
 * account nobody connected is dropped without a trace.
 */
export async function recordZoomParticipantEvent(args: {
  event: "meeting.participant_joined" | "meeting.participant_left";
  accountId: string;
  meeting: ZoomEventMeeting;
  participant: ZoomWebhookParticipant;
}): Promise<"recorded" | "created" | "pending" | "ignored"> {
  const integrations = await loadIntegrationsByAccount(IntegrationProvider.Zoom, args.accountId);
  if (integrations.length === 0) return "ignored";
  const communityIds = integrations.map((i) => i.community_id);
  const { meeting } = args;
  const at = new Date(Date.parse(args.participant.join_time ?? args.participant.leave_time ?? "") || Date.now());

  // A call that created itself follows the meeting, not a typed schedule.
  let linked = meeting.uuid ? await findCallByInstance(communityIds, CallProvider.Zoom, meeting.uuid) : null;
  let call = linked ?? await findCallForMeeting({ communityIds, provider: CallProvider.Zoom, meetingId: meeting.id, at });
  let created = false;
  if (!call && meeting.uuid && args.event === "meeting.participant_joined") {
    const link = await findMeetingLink(communityIds, CallProvider.Zoom, meeting.id);
    if (link) {
      const started = Math.min(Date.parse(meeting.startTime ?? "") || at.getTime(), at.getTime());
      const inserted = await insertLinkedCall(link, {
        instance: meeting.uuid,
        startsAt: new Date(started).toISOString(),
        endsAt: new Date(Math.max(started + link.duration_minutes * 60_000, at.getTime() + MIN_LINKED_CALL_MS)).toISOString(),
      });
      created = inserted !== null;
      // Null: another join of this occurrence created it a moment ago.
      linked = inserted ?? await findCallByInstance([link.community_id], CallProvider.Zoom, meeting.uuid);
      call = linked;
    }
  }
  if (!call) {
    const parked = sessionFromWebhook(args.event, args.participant, NO_NAMES);
    if (!parked) return "ignored";
    await savePendingSession(CallProvider.Zoom, args.accountId, { ref: meeting.id, instance: meeting.uuid, topic: meeting.topic }, parked);
    return "pending";
  }
  const names = await nameContext(call.community_id);
  // An event parked while the call was being created comes in first.
  await replayPending(call, args.accountId, names);
  const session = sessionFromWebhook(args.event, args.participant, names);
  if (!session) return created ? "created" : "ignored";
  // Somebody leaving after the assumed end proves the meeting ran until then.
  if (linked && session.left && Date.parse(session.left) > Date.parse(linked.ends_at)) {
    await setCallEnd(linked.id, session.left);
  }
  await recordSessions(call.id, CallProvider.Zoom, [session]);
  return created ? "created" : "recorded";
}

/** Zoom says the meeting ended: a call that created itself for this occurrence ends then too. */
export async function recordZoomMeetingEnded(args: {
  accountId: string;
  uuid: string;
  endTime: string;
}): Promise<"recorded" | "ignored"> {
  const ended = Date.parse(args.endTime);
  if (Number.isNaN(ended)) return "ignored";
  const integrations = await loadIntegrationsByAccount(IntegrationProvider.Zoom, args.accountId);
  const call = await findCallByInstance(integrations.map((i) => i.community_id), CallProvider.Zoom, args.uuid);
  if (!call) return "ignored";
  await setCallEnd(call.id, new Date(ended).toISOString());
  // Sessions nobody closed now stop at the real end.
  await recomputeCallMinutes(call.id);
  return "recorded";
}

async function replayPending(call: CapturableCall, accountId: string, names: NameMatchContext): Promise<number> {
  const pending = await loadPendingSessions(CallProvider.Zoom, accountId, call);
  if (pending.length === 0) return 0;
  await recordSessions(
    call.id,
    CallProvider.Zoom,
    pending.map((p) => ({ ...p.session, wallet: matchName(p.session.name, names) })),
  );
  // Deleted only once recorded; recording twice is harmless (sessions upsert by source).
  await deletePendingSessions(pending.map((p) => p.id));
  return pending.length;
}

/**
 * A Zoom call was created or edited: bring in the joins and leaves its
 * meeting already produced. Returns how many events were replayed.
 */
export async function replayPendingZoomSessions(call: CapturableCall): Promise<number> {
  if (!call.external_ref) return 0;
  const integration = await loadIntegration(call.community_id, IntegrationProvider.Zoom);
  if (!integration) return 0;
  return replayPending(call, integration.external_account_id, await nameContext(call.community_id));
}

/**
 * Read the participant report of Zoom calls that ended a while ago. A call is
 * marked captured once its report was recorded or turned out to be
 * unavailable (plan or scope); "not found" is retried until the call is a day old.
 */
export async function sweepZoomReports(now: Date): Promise<Record<string, number | string>> {
  const results: Record<string, number | string> = {};
  for (const call of await loadCallsAwaitingReport(CallProvider.Zoom, now, REPORT_BATCH)) {
    const label = `${call.title} (${call.id.slice(0, 8)})`;
    try {
      const integration = await loadIntegration(call.community_id, IntegrationProvider.Zoom);
      if (!integration || !call.external_ref) {
        results[label] = "no Zoom account connected";
        continue;
      }
      const report = await fetchPastParticipants(integration.id, call.external_instance ?? call.external_ref);
      if (report.status === "not-found") {
        results[label] = "no ended meeting under this id yet";
        continue;
      }
      if (report.status === "unavailable") {
        results[label] = `report unavailable: ${report.reason}`;
        await markCallCaptured(call.id);
        continue;
      }
      const sessions = sessionsFromReport(report.participants, await nameContext(call.community_id));
      const recorded = await recordSessions(call.id, CallProvider.Zoom, sessions);
      await markCallCaptured(call.id);
      results[label] = recorded.sessions;
    } catch (err) {
      results[label] = errorMessage(err, "report failed");
    }
  }
  // Parked events nobody claimed belong to meetings that never became calls.
  await purgePendingSessions(now);
  await purgeZoomDeliveries(now);
  return results;
}
