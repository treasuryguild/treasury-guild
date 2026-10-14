// Meetings of the community's connected Zoom account that produced joins in
// the last day and that no call covers yet (the parked events of migration
// 0042, grouped per occurrence). Managers only, and only counts: names stay
// out until a manager lists the meeting as a call.
import { parseQuery, sessionRoute } from "@/lib/api/route";
import { workgroupIdQuerySchema } from "@/lib/api/schemas";
import type { DetectedMeetingsResponse } from "@/lib/api/types";
import { requireWorkgroupManager } from "@/lib/calls/access";
import { groupDetectedMeetings } from "@/lib/calls/zoomSessions";
import { CallProvider, IntegrationProvider } from "@/lib/constants";
import { loadIntegration, loadPendingMeetingEvents } from "@/lib/db/callCapture";
import { requireWorkgroupCommunity } from "@/lib/db/workgroups";

export const GET = sessionRoute(async (req, { session }) => {
  // Any workgroup the caller manages proves they may create calls here.
  const { workgroupId } = parseQuery(req, workgroupIdQuerySchema);
  const communityId = await requireWorkgroupCommunity(workgroupId);
  await requireWorkgroupManager(communityId, workgroupId, session.wallet);

  const integration = await loadIntegration(communityId, IntegrationProvider.Zoom);
  const events = integration ? await loadPendingMeetingEvents(CallProvider.Zoom, integration.external_account_id) : [];
  return { meetings: groupDetectedMeetings(events) } satisfies DetectedMeetingsResponse;
});
