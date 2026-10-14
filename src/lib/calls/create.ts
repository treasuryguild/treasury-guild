// Creating a rewarded call: the checks and the write POST /api/calls makes,
// shared with the agent API's call_create draft (which keys the call by its
// draft id, calls.agent_draft_id, so a repeated confirmation makes no second).
import "server-only";

import type { z } from "zod";
import type { createCallSchema } from "@/lib/api/schemas";
import { CallProvider } from "@/lib/constants";
import { insertCall, insertDraftCall, type NewCall } from "@/lib/db/calls";
import type { CallRow } from "@/lib/db/types";
import { BadRequestError } from "@/lib/errors";
import { requireActiveWorkgroup, requireWorkgroupCommunity } from "@/lib/db/workgroups";
import { requireWorkgroupManager } from "./access";
import { assertCaptureRef } from "./capture";
import { replayPendingZoomSessions } from "./zoomCapture";

export type CreateCallInput = z.infer<typeof createCallSchema>;

/** Who may create this call where, and whether its meeting reference is usable: the community id. */
export async function checkCreateCall(input: CreateCallInput, actor: string): Promise<string> {
  const communityId = await requireWorkgroupCommunity(input.workgroupId);
  await requireWorkgroupManager(communityId, input.workgroupId, actor);
  await requireActiveWorkgroup(input.workgroupId);
  if (input.externalRef) await assertCaptureRef(communityId, input.provider, input.externalRef);
  return communityId;
}

/**
 * Check and create the call. With `agentDraftId`, null when that draft made
 * its call already (the caller looks it up with findCallByDraft). With
 * `communityId`, a workgroup of another community is refused before anything
 * is written.
 */
export async function createCall(
  input: CreateCallInput,
  actor: string,
  opts: { agentDraftId?: string; communityId?: string } = {},
): Promise<CallRow | null> {
  const communityId = await checkCreateCall(input, actor);
  if (opts.communityId && communityId !== opts.communityId) {
    throw new BadRequestError("This draft belongs to another community");
  }
  const row: NewCall = {
    workgroup_id: input.workgroupId,
    provider: input.provider,
    title: input.title,
    external_ref: input.externalRef,
    starts_at: input.startsAt,
    ends_at: input.endsAt,
    amounts: input.amounts,
    min_snapshots: input.minSnapshots,
    min_minutes: input.minMinutes,
    created_by: actor,
  };
  const call = opts.agentDraftId
    ? await insertDraftCall(row, communityId, opts.agentDraftId)
    : await insertCall(row, communityId);
  if (!call) return null;
  // The meeting may already be running: bring in who joined before the call existed.
  if (call.provider === CallProvider.Zoom) {
    await replayPendingZoomSessions(call).catch((err) => console.error("zoom replay failed:", err));
  }
  return call;
}
