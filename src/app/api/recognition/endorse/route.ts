// Lead/admin endorsement of a paid task assignee.
import { parseJson, sessionRoute } from "@/lib/api/route";
import { recognitionEndorseSchema } from "@/lib/api/schemas";
import type { RecognitionCreatedResponse } from "@/lib/api/types";
import { requireWorkgroupManager } from "@/lib/authz";
import { enforceRateLimit } from "@/lib/db/rateLimit";
import { createEndorsement, loadRecognitionSettings } from "@/lib/db/recognition";
import { loadTaskForManager } from "@/lib/db/tasks";
import { NotFoundError } from "@/lib/errors";
import { recognitionSeasonKey } from "@/lib/recognition/season";

export const POST = sessionRoute(async (req, { session }) => {
  const body = await parseJson(req, recognitionEndorseSchema);
  await enforceRateLimit("recognitionEndorse", session.wallet);

  const task = await loadTaskForManager(body.taskId);
  if (!task) throw new NotFoundError("Task not found");

  const communityId = task.workgroups.community_id;
  const settings = await loadRecognitionSettings(communityId);
  if (!settings.enabled) throw new NotFoundError("Recognition is not enabled");

  await requireWorkgroupManager(communityId, task.workgroup_id, session.wallet);

  const id = await createEndorsement({
    taskId: body.taskId,
    subjectWallet: body.subjectWallet,
    actor: session.wallet,
    seasonKey: recognitionSeasonKey(settings.season),
    note: body.note,
  });
  return { id } satisfies RecognitionCreatedResponse;
});
