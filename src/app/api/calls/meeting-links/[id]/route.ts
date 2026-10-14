// Edit or remove a linked meeting. Calls it already created keep their own
// title and reward; removing the link only stops new ones.
import { parseJson, sessionRoute } from "@/lib/api/route";
import { patchMeetingLinkSchema } from "@/lib/api/schemas";
import type { MeetingLinkResponse, OkResponse } from "@/lib/api/types";
import { requireWorkgroupManager } from "@/lib/calls/access";
import { deleteMeetingLink, loadMeetingLink, updateMeetingLink } from "@/lib/db/callCapture";
import { requireActiveWorkgroup } from "@/lib/db/workgroups";
import type { CallMeetingLinkRow } from "@/lib/db/types";
import { NotFoundError } from "@/lib/errors";

async function loadLinkForManager(linkId: string, wallet: string): Promise<CallMeetingLinkRow> {
  const link = await loadMeetingLink(linkId);
  if (!link) throw new NotFoundError("Linked meeting not found");
  await requireWorkgroupManager(link.community_id, link.workgroup_id, wallet);
  // Archived workgroups are frozen, as for their calls and for a new link.
  await requireActiveWorkgroup(link.workgroup_id);
  return link;
}

export const PATCH = sessionRoute<{ id: string }>(async (req, { params, session }) => {
  const body = await parseJson(req, patchMeetingLinkSchema);
  const link = await loadLinkForManager(params.id, session.wallet);
  const updated = await updateMeetingLink(link.id, {
    ...(body.title !== undefined && { title: body.title }),
    ...(body.amounts !== undefined && { amounts: body.amounts }),
    ...(body.minMinutes !== undefined && { min_minutes: body.minMinutes }),
    ...(body.durationMinutes !== undefined && { duration_minutes: body.durationMinutes }),
  });
  return { link: updated } satisfies MeetingLinkResponse;
});

export const DELETE = sessionRoute<{ id: string }>(async (_req, { params, session }) => {
  const link = await loadLinkForManager(params.id, session.wallet);
  await deleteMeetingLink(link.id);
  return { ok: true } satisfies OkResponse;
});
