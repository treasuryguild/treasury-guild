// Paying a call's attendance: who the next finalize rewards, and the finalize
// itself, as POST /api/calls/[id]/finalize does it and the agent API's
// call_finalize draft repeats it. finalize_call (via finalize_call_at_reward)
// writes atomically and skips anyone who already has a task, so a repeat
// never pays twice.
import "server-only";

import { adaLovelaceFromAmounts } from "@/lib/assets";
import { monthOf } from "@/lib/budgets";
import { taskBudgetPeriod } from "@/lib/budgetSetups";
import { MAX_TASK_ASSIGNEES } from "@/lib/constants";
import { loadBudgetSetupsForWorkgroups } from "@/lib/db/budgetSetups";
import { recomputeCallMinutes } from "@/lib/db/callCapture";
import { finalizeCall, loadCallAttendees, type CallWithWorkgroup, type FinalizeCallResult } from "@/lib/db/calls";
import { setBudgetMonthIfNull } from "@/lib/db/tasks";
import type { CallAttendeeRow } from "@/lib/db/types";
import { BadRequestError } from "@/lib/errors";
import { attendeesToFinalize, countStandings, type AttendeeStanding } from "./qualify";

export interface FinalizePlan {
  /** The attendees the finalize would reward now. */
  ready: CallAttendeeRow[];
  standings: Record<AttendeeStanding, number>;
  /** Tasks it would create (attendees are split into chunks of MAX_TASK_ASSIGNEES). */
  tasks: number;
}

/**
 * Who the next finalize rewards. Minutes of someone still in the meeting
 * count up to now, so they are brought up to date first (a recompute of the
 * stored sessions, which changes nothing else).
 */
export async function planFinalize(call: CallWithWorkgroup): Promise<FinalizePlan> {
  await recomputeCallMinutes(call.id);
  const attendees = await loadCallAttendees(call.id);
  const ready = attendeesToFinalize(call, attendees);
  return {
    ready,
    standings: countStandings(call, attendees),
    tasks: Math.ceil(ready.length / MAX_TASK_ASSIGNEES),
  };
}

/** Turn the ready attendees into attendance task(s); 400 when nobody is ready. */
export async function finalizeReady(
  call: CallWithWorkgroup,
  actor: string,
  ready: readonly Pick<CallAttendeeRow, "id">[],
): Promise<FinalizeCallResult> {
  if (ready.length === 0) throw new BadRequestError("Nobody to reward yet: attendees need a linked wallet");
  const result = await finalizeCall({
    callId: call.id,
    actor,
    attendeeIds: ready.map((a) => a.id),
    chunk: MAX_TASK_ASSIGNEES,
    bountyLovelace: adaLovelaceFromAmounts(call.amounts),
    amounts: call.amounts,
  });
  // A call rewarded weeks later still counts against the period it happened
  // in (its quarter in a quarterly workgroup), not the one it is paid in.
  // Best effort: a task left unset is stamped by build-payout as before.
  if (result.taskIds.length > 0) {
    try {
      const callMonth = monthOf(call.starts_at);
      const setups = (await loadBudgetSetupsForWorkgroups([call.workgroup_id])).get(call.workgroup_id) ?? [];
      await setBudgetMonthIfNull(result.taskIds, taskBudgetPeriod(callMonth, setups, callMonth).month);
    } catch (err) {
      console.error("stamping the call's budget month failed:", err);
    }
  }
  return result;
}
