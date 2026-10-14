// The community-level governance settings (migration 0059): where frozen
// tally documents are published (off by default; publication cannot be
// undone, so the page confirms first) and whether a spend that fails the
// budget check is warned about or refused. Members read; admins save, and
// the change is logged with the per-kind ones.
import { parseJson, parseQuery, sessionRoute } from "@/lib/api/route";
import { communityIdSchema, saveGovernanceCommunitySettingsSchema } from "@/lib/api/schemas";
import type { GovernanceCommunitySettingsResponse, OkResponse } from "@/lib/api/types";
import { requireAdmin, requireMember } from "@/lib/authz";
import { loadGovernanceCommunitySettings, saveGovernanceCommunitySettings } from "@/lib/db/governance";

export const GET = sessionRoute(async (req, { session }) => {
  const { communityId } = parseQuery(req, communityIdSchema);
  await requireMember(communityId, session.wallet);
  return { settings: await loadGovernanceCommunitySettings(communityId) } satisfies GovernanceCommunitySettingsResponse;
});

export const POST = sessionRoute(async (req, { session }) => {
  const { communityId, documentStore, spendCheck } = await parseJson(req, saveGovernanceCommunitySettingsSchema);
  await requireAdmin(communityId, session.wallet);
  await saveGovernanceCommunitySettings(communityId, { documentStore, spendCheck }, session.wallet);
  return { ok: true } satisfies OkResponse;
});
