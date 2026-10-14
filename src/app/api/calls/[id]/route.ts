// Edit or delete a call. Once attendance tasks exist the reward is what those
// tasks carry, so it is locked, and the call can no longer be deleted.
import { parseJson, sessionRoute } from "@/lib/api/route";
import { patchCallSchema } from "@/lib/api/schemas";
import type { CallResponse, OkResponse } from "@/lib/api/types";
import { loadCallForManager } from "@/lib/calls/access";
import { assertCaptureRef } from "@/lib/calls/capture";
import { replayPendingZoomSessions } from "@/lib/calls/zoomCapture";
import { CallProvider, CallState } from "@/lib/constants";
import { deleteCallWithoutTasks, setCallAmounts, updateCall } from "@/lib/db/calls";

export const PATCH = sessionRoute<{ id: string }>(async (req, { params, session }) => {
  const body = await parseJson(req, patchCallSchema);
  const call = await loadCallForManager(params.id, session.wallet);
  if (body.externalRef) await assertCaptureRef(call.community_id, call.provider, body.externalRef);
  // The reward first, checked against attendance tasks under the call's row
  // lock (409 once one exists): nothing else is saved when it is refused.
  let updated = body.amounts !== undefined ? await setCallAmounts(call.id, body.amounts) : null;
  const rest = {
    ...(body.title !== undefined && { title: body.title }),
    ...(body.externalRef !== undefined && { external_ref: body.externalRef }),
    ...(body.startsAt !== undefined && { starts_at: body.startsAt }),
    ...(body.endsAt !== undefined && { ends_at: body.endsAt }),
    ...(body.minSnapshots !== undefined && { min_snapshots: body.minSnapshots }),
    ...(body.minMinutes !== undefined && { min_minutes: body.minMinutes }),
  };
  if (Object.keys(rest).length > 0 || !updated) updated = await updateCall(call.id, rest);
  // A new meeting id or time window may now cover events that arrived before it did.
  if (updated.provider === CallProvider.Zoom && updated.state === CallState.Open) {
    await replayPendingZoomSessions(updated).catch((err) => console.error("zoom replay failed:", err));
  }
  return { call: updated } satisfies CallResponse;
});

export const DELETE = sessionRoute<{ id: string }>(async (_req, { params, session }) => {
  const call = await loadCallForManager(params.id, session.wallet);
  // Checked under the call's row lock: a finalize cannot land in between.
  await deleteCallWithoutTasks(call.id);
  return { ok: true } satisfies OkResponse;
});
