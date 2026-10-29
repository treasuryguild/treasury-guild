// Who on a call's list is rewarded. Pure: the finalize route, the call page
// and the tests share one answer.
//
// A manager's entry is its own proof of presence. A check-in needs a
// manager's confirm (a code on a shared screen is guessable). Captured
// attendees (Discord snapshots, Zoom/Meet minutes) must meet the call's
// threshold unless a manager confirmed them. finalize_call re-checks what
// money depends on: a wallet, no task yet, not excluded.

import { AttendeeSource, AttendeeStatus } from "@/lib/constants";
import type { CallAttendeeRow, CallRow } from "@/lib/db/types";

type Threshold = Pick<CallRow, "min_snapshots" | "min_minutes">;
type Presence = Pick<CallAttendeeRow, "provider" | "status" | "snapshots_seen" | "minutes">;
type Payable = Presence & Pick<CallAttendeeRow, "wallet_address" | "task_id">;

/** Present enough to be rewarded, whatever the wallet situation. */
export function meetsThreshold(call: Threshold, attendee: Presence): boolean {
  if (attendee.status === AttendeeStatus.Excluded) return false;
  if (attendee.status === AttendeeStatus.Confirmed) return true;
  switch (attendee.provider) {
    case AttendeeSource.Discord:
      return attendee.snapshots_seen >= call.min_snapshots;
    case AttendeeSource.Zoom:
    case AttendeeSource.Meet:
      return attendee.minutes >= call.min_minutes;
    // A leaked check-in code must not auto-qualify; a manager confirms them.
    case AttendeeSource.Checkin:
      return false;
    // A manager's own entry is its own proof of presence.
    default:
      return true;
  }
}

export type AttendeeStanding =
  /** Already on an attendance task. */
  | "rewarded"
  | "excluded"
  /** Captured, but below the call's threshold. */
  | "below-threshold"
  /** Would be rewarded, but has no wallet yet. */
  | "unlinked"
  /** The next finalize creates a task for them. */
  | "ready";

export function attendeeStanding(call: Threshold, attendee: Payable): AttendeeStanding {
  if (attendee.task_id) return "rewarded";
  if (attendee.status === AttendeeStatus.Excluded) return "excluded";
  if (!meetsThreshold(call, attendee)) return "below-threshold";
  return attendee.wallet_address ? "ready" : "unlinked";
}

/** The attendees the next finalize turns into task assignees. */
export function attendeesToFinalize<T extends Payable>(call: Threshold, attendees: T[]): T[] {
  return attendees.filter((a) => attendeeStanding(call, a) === "ready");
}

/** How many attendees are in each standing (the call list and the finalize preview). */
export function countStandings(
  call: Threshold,
  attendees: readonly Payable[],
): Record<AttendeeStanding, number> {
  const counts: Record<AttendeeStanding, number> = {
    rewarded: 0, excluded: 0, "below-threshold": 0, unlinked: 0, ready: 0,
  };
  for (const a of attendees) counts[attendeeStanding(call, a)] += 1;
  return counts;
}
