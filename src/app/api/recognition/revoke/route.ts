// Soft-revoke a recognition event (grantor or admin).
import { parseJson, sessionRoute } from "@/lib/api/route";
import { recognitionRevokeSchema } from "@/lib/api/schemas";
import type { OkResponse } from "@/lib/api/types";
import { requireMember } from "@/lib/authz";
import { maybe, serviceClient } from "@/lib/db/client";
import { RECOGNITION_EVENT_COLUMNS, type RecognitionEventRow } from "@/lib/db/types";
import { revokeRecognitionEvent } from "@/lib/db/recognition";
import { NotFoundError } from "@/lib/errors";

export const POST = sessionRoute(async (req, { session }) => {
  const body = await parseJson(req, recognitionRevokeSchema);
  const event = maybe<RecognitionEventRow>(
    await serviceClient().from("recognition_events").select(RECOGNITION_EVENT_COLUMNS)
      .eq("id", body.eventId).maybeSingle(),
    "load recognition event",
  );
  if (!event) throw new NotFoundError("Recognition event not found");
  await requireMember(event.community_id, session.wallet);
  await revokeRecognitionEvent(body.eventId, session.wallet, body.reason);
  return { ok: true } satisfies OkResponse;
});
