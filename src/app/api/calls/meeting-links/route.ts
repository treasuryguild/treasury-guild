// Link a recurring Zoom or Google Meet meeting to the workgroup that rewards
// it: its calls then create themselves when the meeting runs (migrations 0043,
// 0044). Admins and the workgroup's leads; members read links through RLS.
import { parseJson, sessionRoute } from "@/lib/api/route";
import { createMeetingLinkSchema } from "@/lib/api/schemas";
import type { MeetingLinkResponse } from "@/lib/api/types";
import { requireWorkgroupManager } from "@/lib/calls/access";
import { assertCaptureRef } from "@/lib/calls/capture";
import { insertMeetingLink } from "@/lib/db/callCapture";
import { requireActiveWorkgroup, requireWorkgroupCommunity } from "@/lib/db/workgroups";

export const POST = sessionRoute(async (req, { session }) => {
  const body = await parseJson(req, createMeetingLinkSchema);
  const communityId = await requireWorkgroupCommunity(body.workgroupId);
  await requireWorkgroupManager(communityId, body.workgroupId, session.wallet);
  await requireActiveWorkgroup(body.workgroupId);
  // Also requires the platform's host account to be connected.
  await assertCaptureRef(communityId, body.provider, body.meetingRef);

  const link = await insertMeetingLink(
    {
      workgroup_id: body.workgroupId,
      provider: body.provider,
      meeting_ref: body.meetingRef,
      title: body.title,
      amounts: body.amounts,
      min_minutes: body.minMinutes,
      duration_minutes: body.durationMinutes,
      created_by: session.wallet,
    },
    communityId,
  );
  return { link } satisfies MeetingLinkResponse;
});
