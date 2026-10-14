// The voice channels a Discord call of this workgroup can be captured from:
// those of the server the community connected. Admins and the workgroup's leads.
import { parseQuery, sessionRoute } from "@/lib/api/route";
import { workgroupIdQuerySchema } from "@/lib/api/schemas";
import type { DiscordChannelsResponse } from "@/lib/api/types";
import { requireWorkgroupManager } from "@/lib/calls/access";
import { IntegrationProvider } from "@/lib/constants";
import { loadIntegration } from "@/lib/db/callCapture";
import { requireWorkgroupCommunity } from "@/lib/db/workgroups";
import { listVoiceChannels } from "@/lib/discord/bot";

export const GET = sessionRoute(async (req, { session }) => {
  const { workgroupId } = parseQuery(req, workgroupIdQuerySchema);
  const communityId = await requireWorkgroupCommunity(workgroupId);
  await requireWorkgroupManager(communityId, workgroupId, session.wallet);

  const integration = await loadIntegration(communityId, IntegrationProvider.Discord);
  const channels = integration ? await listVoiceChannels(integration.external_account_id) : null;
  return {
    connected: channels !== null,
    serverName: integration?.label ?? null,
    channels: channels ?? [],
  } satisfies DiscordChannelsResponse;
});
