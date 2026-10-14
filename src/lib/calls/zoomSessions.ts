// Zoom's two views of who was in a meeting -> presence sessions for
// record_call_sessions (migration 0040). Pure.
//
// Most attendees are guests: Zoom knows them by the name they typed and
// nothing else. A participant who is signed in to Zoom carries a stable user
// id; everyone else is keyed by their normalized name, so the same guest
// rejoining (or showing up in both the webhook and the report) stays one
// attendee. No email is read, kept or passed on.

import { matchName, normalizeName, type NameMatchContext } from "./nameMatch";

export interface PresenceSession {
  /** Stable per person within a call: Zoom user id, else "name:<normalized name>". */
  key: string;
  name: string;
  /** Wallet suggested by name (remembered alias or a unique member match). */
  wallet: string | null;
  joined: string | null;
  left: string | null;
  /** Unique per piece of evidence; null for a leave-only event. */
  source: string | null;
}

/** The participant object of meeting.participant_joined / _left webhooks. */
export interface ZoomWebhookParticipant {
  user_name?: string;
  /** Zoom account user id; empty for guests. */
  id?: string;
  participant_user_id?: string;
  /** Stable for one stay in the meeting. */
  participant_uuid?: string;
  /** In-meeting id; changes when the participant rejoins. */
  user_id?: string;
  join_time?: string;
  leave_time?: string;
}

/** One row of GET /past_meetings/{id}/participants. */
export interface ZoomReportParticipant {
  /** Zoom account user id; empty for guests. */
  id?: string;
  name?: string;
  join_time?: string;
  leave_time?: string;
}

function participantKey(zoomUserId: string | undefined, name: string): string | null {
  if (zoomUserId) return zoomUserId;
  const normalized = normalizeName(name);
  return normalized ? `name:${normalized}` : null;
}

/** A provider timestamp as canonical ISO, or null when absent or unreadable. */
export function iso(value: string | undefined): string | null {
  if (!value) return null;
  const time = Date.parse(value);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

/** A live join or leave event, or null when it names nobody. */
export function sessionFromWebhook(
  event: "meeting.participant_joined" | "meeting.participant_left",
  participant: ZoomWebhookParticipant,
  names: NameMatchContext,
): PresenceSession | null {
  const name = participant.user_name?.trim() ?? "";
  const key = participantKey(participant.id || participant.participant_user_id, name);
  if (!key) return null;
  const base = { key, name, wallet: matchName(name, names) };
  if (event === "meeting.participant_joined") {
    const joined = iso(participant.join_time);
    if (!joined) return null;
    const stay = participant.participant_uuid || participant.user_id || key;
    return { ...base, joined, left: null, source: `zoom:wh:${stay}:${joined}` };
  }
  const left = iso(participant.leave_time);
  return left ? { ...base, joined: null, left, source: null } : null;
}

/** The meeting's participant report: one session per row that has a join time. */
export function sessionsFromReport(
  participants: readonly ZoomReportParticipant[],
  names: NameMatchContext,
): PresenceSession[] {
  const sessions: PresenceSession[] = [];
  for (const p of participants) {
    const name = p.name?.trim() ?? "";
    const key = participantKey(p.id, name);
    const joined = iso(p.join_time);
    if (!key || !joined) continue;
    sessions.push({
      key,
      name,
      wallet: matchName(name, names),
      joined,
      left: iso(p.leave_time),
      source: `zoom:rp:${key}:${joined}`,
    });
  }
  return sessions;
}

/** "812 3456 7890" as people paste it -> the id Zoom's API and webhooks use. */
export function normalizeMeetingId(input: string): string {
  return input.replace(/[\s-]/g, "");
}

/** A parked join or leave (migration 0042), as the detected-meetings list reads it. */
export interface PendingMeetingEvent {
  meetingRef: string;
  /** Zoom's uuid of this occurrence of the meeting, when the event carried one. */
  instance: string | null;
  topic: string | null;
  key: string;
  joined: string | null;
  left: string | null;
}

/** A meeting of the connected account that no call covers yet. */
export interface DetectedMeeting {
  meetingRef: string;
  instance: string | null;
  topic: string | null;
  /** First join seen. */
  startedAt: string;
  /** Last leave seen; null while somebody is still in the meeting. */
  endedAt: string | null;
  participants: number;
}

/** Parked events -> one row per occurrence of a meeting, newest first. No names leave this function. */
export function groupDetectedMeetings(events: readonly PendingMeetingEvent[]): DetectedMeeting[] {
  const groups = new Map<string, PendingMeetingEvent[]>();
  for (const e of events) {
    const id = `${e.meetingRef}:${e.instance ?? ""}`;
    groups.set(id, [...(groups.get(id) ?? []), e]);
  }
  const meetings: DetectedMeeting[] = [];
  for (const group of groups.values()) {
    const times = group.map((e) => e.joined ?? e.left).filter((t): t is string => !!t).sort();
    const first = group[0];
    const startedAt = times[0];
    if (!first || !startedAt) continue;
    // Somebody is still in when the latest thing known about them is a join.
    const latest = new Map<string, { at: string; joined: boolean }>();
    for (const e of group) {
      const at = e.joined ?? e.left;
      if (!at) continue;
      const seen = latest.get(e.key);
      if (!seen || at >= seen.at) latest.set(e.key, { at, joined: e.joined !== null });
    }
    const running = [...latest.values()].some((p) => p.joined);
    meetings.push({
      meetingRef: first.meetingRef,
      instance: first.instance,
      topic: group.find((e) => e.topic)?.topic ?? null,
      startedAt,
      endedAt: running ? null : times[times.length - 1] ?? startedAt,
      participants: latest.size,
    });
  }
  return meetings.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
}
