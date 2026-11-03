// Recognition module settings: members read merged defaults; admins save.
import { parseJson, parseQuery, sessionRoute } from "@/lib/api/route";
import { communityIdSchema, saveRecognitionSettingsSchema } from "@/lib/api/schemas";
import type { OkResponse, RecognitionSettingsResponse } from "@/lib/api/types";
import { requireAdmin, requireMember } from "@/lib/authz";
import { loadRecognitionSettings, saveRecognitionSettings } from "@/lib/db/recognition";

export const GET = sessionRoute(async (req, { session }) => {
  const { communityId } = parseQuery(req, communityIdSchema);
  await requireMember(communityId, session.wallet);
  const settings = await loadRecognitionSettings(communityId);
  return { settings } satisfies RecognitionSettingsResponse;
});

export const POST = sessionRoute(async (req, { session }) => {
  const body = await parseJson(req, saveRecognitionSettingsSchema);
  await requireAdmin(body.communityId, session.wallet);
  await saveRecognitionSettings(body.communityId, {
    enabled: body.enabled,
    season: body.season,
    maxEndorsementsPerActorSeason: body.maxEndorsementsPerActorSeason,
    showLeaderboard: body.showLeaderboard,
    peerKudosEnabled: body.peerKudosEnabled,
    minMemberDaysToKudos: body.minMemberDaysToKudos,
    electorateEndorsed: body.electorateEndorsed,
    endorsedMinScore: body.endorsedMinScore,
  }, session.wallet);
  return { ok: true } satisfies OkResponse;
});
