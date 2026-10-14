// Google Meet's conference records -> presence sessions for
// record_call_sessions (migration 0040). Pure.
//
// A signed-in participant carries "users/<id>", where <id> is the Google
// account's id: the same value as the OpenID `sub` a contributor links on
// their profile, so they are recognised exactly. Anonymous and dial-in
// participants are names only and go through name matching like Zoom guests.

import { matchName, normalizeName, type NameMatchContext } from "./nameMatch";
import { iso, type PresenceSession } from "./zoomSessions";

/** conferenceRecords.participants resource (the fields capture reads). */
export interface MeetParticipant {
  /** "conferenceRecords/<record>/participants/<participant>" */
  name: string;
  earliestStartTime?: string;
  latestEndTime?: string;
  signedinUser?: { user?: string; displayName?: string };
  anonymousUser?: { displayName?: string };
  phoneUser?: { displayName?: string };
}

/** conferenceRecords.participants.participantSessions resource. */
export interface MeetParticipantSession {
  /** Unique and stable per stay. */
  name: string;
  startTime?: string;
  /** Absent while the participant is still in the meeting. */
  endTime?: string;
}

export interface MeetConferenceRecord {
  /** "conferenceRecords/<record>" */
  name: string;
  startTime?: string;
  /** Absent while the conference is running. */
  endTime?: string;
}


/** The Google account id of a signed-in participant ("users/123" -> "123"), or null. */
export function meetAccountId(participant: MeetParticipant): string | null {
  const match = /^users\/(.+)$/.exec(participant.signedinUser?.user ?? "");
  return match?.[1] ?? null;
}

/**
 * One participant's stays as sessions. `stays` is what the API listed for them;
 * when it could not be read, the participant's first-to-last span stands in
 * (it over-counts a gap, which a manager can see and correct, but loses nobody).
 */
export function sessionsFromMeetParticipant(
  participant: MeetParticipant,
  stays: readonly MeetParticipantSession[] | null,
  ctx: { names: NameMatchContext; walletsByAccount: ReadonlyMap<string, string> },
): PresenceSession[] {
  const accountId = meetAccountId(participant);
  const name = (
    participant.signedinUser?.displayName ?? participant.anonymousUser?.displayName ??
    participant.phoneUser?.displayName ?? ""
  ).trim();
  const normalized = normalizeName(name);
  const key = accountId ?? (normalized ? `name:${normalized}` : null);
  if (!key) return [];
  // A linked Google account is proof; a typed name is only a suggestion.
  const wallet = (accountId ? ctx.walletsByAccount.get(accountId) : undefined) ?? matchName(name, ctx.names);

  const spans = stays && stays.length > 0
    ? stays.map((s) => ({ source: s.name, joined: iso(s.startTime), left: iso(s.endTime) }))
    : [{ source: `${participant.name}:span`, joined: iso(participant.earliestStartTime), left: iso(participant.latestEndTime) }];
  return spans.flatMap((span) =>
    span.joined ? [{ key, name, wallet, joined: span.joined, left: span.left, source: `meet:${span.source}` }] : [],
  );
}

/**
 * The conference a call refers to. A meeting code is reused for every
 * occurrence, so among the code's records take the one that overlaps the
 * call (started before it ends, and not over before it starts); the latest
 * such start wins. `slackMs` allows for people opening the room early.
 */
export function pickConferenceRecord(
  records: readonly MeetConferenceRecord[],
  call: { starts_at: string; ends_at: string },
  slackMs = 60 * 60 * 1000,
): MeetConferenceRecord | null {
  const callStart = Date.parse(call.starts_at);
  const callEnd = Date.parse(call.ends_at);
  const overlapping = records.filter((r) => {
    const start = Date.parse(r.startTime ?? "");
    if (Number.isNaN(start) || start > callEnd || start < callStart - slackMs) return false;
    const end = r.endTime ? Date.parse(r.endTime) : Infinity;
    return end >= callStart;
  });
  overlapping.sort((a, b) => Date.parse(b.startTime ?? "") - Date.parse(a.startTime ?? ""));
  return overlapping[0] ?? null;
}

/** A created call runs at least this long past "now", so a late discovery is not born ended. */
const MIN_LINKED_CALL_MS = 5 * 60 * 1000;
/** A conference over for longer than this is not turned into a call any more. */
const LINKED_ENDED_WINDOW_MS = 60 * 60 * 1000;
/** A running conference keeps its call's end at least this far ahead (two cron runs). */
const LINKED_END_AHEAD_MS = 10 * 60 * 1000;

/**
 * The call a linked Meet code's conference becomes, or null when it should
 * not become one. Meet pushes nothing, so the cron finds the conference after
 * the fact: a running one always counts; an ended one only when it began
 * after the link was made and ended recently, so a short meeting between two
 * runs is still caught while a call a manager deleted does not come back.
 */
export function linkedOccurrence(
  record: MeetConferenceRecord,
  link: { created_at: string; duration_minutes: number },
  now: Date,
): { instance: string; startsAt: string; endsAt: string } | null {
  const start = Date.parse(record.startTime ?? "");
  if (Number.isNaN(start) || start > now.getTime()) return null;
  const end = record.endTime ? Date.parse(record.endTime) : null;
  if (end !== null) {
    if (Number.isNaN(end) || end <= start) return null;
    if (start < Date.parse(link.created_at) || now.getTime() - end > LINKED_ENDED_WINDOW_MS) return null;
  }
  const endsAt = end ?? Math.max(start + link.duration_minutes * 60_000, now.getTime() + MIN_LINKED_CALL_MS);
  return { instance: record.name, startsAt: new Date(start).toISOString(), endsAt: new Date(endsAt).toISOString() };
}

/**
 * Where the end of a call that created itself should move, or null to leave
 * it: Google's end once the conference is over, else far enough ahead that a
 * conference running past its usual length stays a running call (presence is
 * clipped to the call's times).
 */
export function followedEnd(
  record: MeetConferenceRecord,
  call: { starts_at: string; ends_at: string },
  now: Date,
): string | null {
  const current = Date.parse(call.ends_at);
  const end = record.endTime ? Date.parse(record.endTime) : null;
  if (end !== null) {
    if (Number.isNaN(end) || end <= Date.parse(call.starts_at) || end === current) return null;
    return new Date(end).toISOString();
  }
  const ahead = now.getTime() + LINKED_END_AHEAD_MS;
  return current < ahead ? new Date(ahead).toISOString() : null;
}

export const MEET_CODE_RE = /^[a-z]{3}-[a-z]{4}-[a-z]{3}$/;

/** A pasted link or code -> "abc-mnop-xyz", or null when it is not a Meet code. */
export function normalizeMeetCode(input: string): string | null {
  const trimmed = input.trim().toLowerCase();
  const fromUrl = /meet\.google\.com\/([a-z]{3}-?[a-z]{4}-?[a-z]{3})/.exec(trimmed)?.[1] ?? trimmed;
  const letters = fromUrl.replace(/-/g, "");
  if (!/^[a-z]{10}$/.test(letters)) return null;
  const code = `${letters.slice(0, 3)}-${letters.slice(3, 7)}-${letters.slice(7)}`;
  return MEET_CODE_RE.test(code) ? code : null;
}
