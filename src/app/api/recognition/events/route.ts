// List recognition events for a task or a season (with scores).
import { parseQuery, sessionRoute } from "@/lib/api/route";
import { recognitionEventsQuerySchema } from "@/lib/api/schemas";
import type { RecognitionEventsResponse } from "@/lib/api/types";
import { requireMember } from "@/lib/authz";
import {
  countActorEndorsements,
  listRecognitionEventsForSeason,
  listRecognitionEventsForTask,
  loadRecognitionSettings,
} from "@/lib/db/recognition";
import { loadTaskForManager } from "@/lib/db/tasks";
import { BadRequestError, NotFoundError } from "@/lib/errors";
import { seasonScores, tierForScore } from "@/lib/recognition/score";
import { recognitionSeasonKey } from "@/lib/recognition/season";

export const GET = sessionRoute(async (req, { session }) => {
  const query = parseQuery(req, recognitionEventsQuerySchema);

  if (query.taskId) {
    const task = await loadTaskForManager(query.taskId);
    if (!task) throw new NotFoundError("Task not found");
    const communityId = task.workgroups.community_id;
    await requireMember(communityId, session.wallet);
    const settings = await loadRecognitionSettings(communityId);
    const events = await listRecognitionEventsForTask(query.taskId);
    const seasonKey = recognitionSeasonKey(settings.season);
    const used = await countActorEndorsements(communityId, seasonKey, session.wallet);
    return {
      events,
      seasonKey,
      endorsementsRemaining: Math.max(0, settings.maxEndorsementsPerActorSeason - used),
    } satisfies RecognitionEventsResponse;
  }

  if (!query.communityId || !query.seasonKey) {
    throw new BadRequestError("Provide taskId, or communityId with seasonKey");
  }
  await requireMember(query.communityId, session.wallet);
  const settings = await loadRecognitionSettings(query.communityId);
  if (!settings.enabled) throw new NotFoundError("Recognition is not enabled");

  const events = await listRecognitionEventsForSeason(query.communityId, query.seasonKey);
  const scores = [...seasonScores(events).entries()]
    .map(([wallet, score]) => ({ wallet, score, tier: tierForScore(score) }))
    .sort((a, b) => b.score - a.score || a.wallet.localeCompare(b.wallet));
  const used = await countActorEndorsements(query.communityId, query.seasonKey, session.wallet);
  return {
    events,
    scores,
    seasonKey: query.seasonKey,
    endorsementsRemaining: Math.max(0, settings.maxEndorsementsPerActorSeason - used),
  } satisfies RecognitionEventsResponse;
});
