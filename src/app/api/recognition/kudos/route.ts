// Peer kudos on a paid task assignee (when peer_kudos_enabled).
import { parseJson, sessionRoute } from "@/lib/api/route";
import { recognitionKudosSchema } from "@/lib/api/schemas";
import type { RecognitionCreatedResponse } from "@/lib/api/types";
import { requireMember } from "@/lib/authz";
import { enforceRateLimit } from "@/lib/db/rateLimit";
import { createPeerKudos, loadRecognitionSettings } from "@/lib/db/recognition";
import { loadTaskForManager } from "@/lib/db/tasks";
import { NotFoundError } from "@/lib/errors";
import { recognitionSeasonKey } from "@/lib/recognition/season";

export const POST = sessionRoute(async (req, { session }) => {
  const body = await parseJson(req, recognitionKudosSchema);
  await enforceRateLimit("recognitionKudos", session.wallet);

  const task = await loadTaskForManager(body.taskId);
  if (!task) throw new NotFoundError("Task not found");

  const communityId = task.workgroups.community_id;
  const settings = await loadRecognitionSettings(communityId);
  if (!settings.enabled || !settings.peerKudosEnabled) {
    throw new NotFoundError("Peer kudos is not enabled");
  }

  await requireMember(communityId, session.wallet);

  const id = await createPeerKudos({
    taskId: body.taskId,
    subjectWallet: body.subjectWallet,
    actor: session.wallet,
    seasonKey: recognitionSeasonKey(settings.season),
    note: body.note,
  });
  return { id } satisfies RecognitionCreatedResponse;
});
