// Zoom event subscription endpoint: POST /api/zoom/webhook.
//
// Fast path only, like the GitHub webhook: verify the signature over the raw
// body, record one join or leave, answer 200. Whatever is missed here (an
// undelivered event, an error) is repaired by the participant report the
// calls-sync cron reads after the meeting. Payloads are never stored: they
// carry participants' emails, which this app has no use for. An event that
// matches no call yet is parked as a bare session (key, name, times) for a
// day, because hosts open the meeting before they create the call.
import { publicRoute } from "@/lib/api/route";
import { recordZoomMeetingEnded, recordZoomParticipantEvent } from "@/lib/calls/zoomCapture";
import type { ZoomWebhookParticipant } from "@/lib/calls/zoomSessions";
import { verifyZoomSignature, zoomUrlValidationResponse } from "@/lib/calls/zoomSignature";
import { IntegrationProvider } from "@/lib/constants";
import { deleteIntegrationsByAccount, markZoomDeliverySeen } from "@/lib/db/callCapture";
import { zoomWebhookSecret } from "@/lib/env.server";
import { UnauthorizedError } from "@/lib/errors";

interface ZoomEvent {
  event?: string;
  payload?: {
    account_id?: string;
    plainToken?: string;
    object?: {
      id?: string | number;
      uuid?: string;
      topic?: string;
      start_time?: string;
      end_time?: string;
      participant?: ZoomWebhookParticipant;
    };
  };
}

export const POST = publicRoute(async (req) => {
  // Raw body first: the signature covers the exact bytes.
  const rawBody = await req.text();
  const secret = zoomWebhookSecret();
  const signature = req.headers.get("x-zm-signature");
  if (!signature || !verifyZoomSignature({
    secret,
    timestamp: req.headers.get("x-zm-request-timestamp"),
    signature,
    rawBody,
  })) {
    throw new UnauthorizedError("Invalid Zoom signature");
  }
  // A signed request is valid for minutes: one sent again is ignored, so a
  // captured app_deauthorized or join cannot undo what happened since.
  // A failure here, or in the deauthorize below, is deliberately not caught:
  // the error response makes Zoom redeliver (new timestamp, new signature),
  // and a dropped connection has no report sweep to repair it.
  if (!(await markZoomDeliverySeen(signature))) return { ok: true, outcome: "duplicate" };

  const body = JSON.parse(rawBody) as ZoomEvent;
  const payload = body.payload ?? {};

  // Zoom proves the endpoint (on save, and every 72 hours) with a challenge.
  if (body.event === "endpoint.url_validation" && payload.plainToken) {
    return zoomUrlValidationResponse(secret, payload.plainToken);
  }
  // The account removed the app: its tokens are dead, forget the connection.
  if (body.event === "app_deauthorized" && payload.account_id) {
    await deleteIntegrationsByAccount(IntegrationProvider.Zoom, payload.account_id);
    return { ok: true };
  }

  const meeting = payload.object;
  // Optional subscription: it tells a call that created itself when it really ended.
  if (body.event === "meeting.ended" && payload.account_id && meeting?.uuid && meeting.end_time) {
    try {
      const outcome = await recordZoomMeetingEnded({
        accountId: payload.account_id, uuid: meeting.uuid, endTime: meeting.end_time,
      });
      return { ok: true, outcome };
    } catch (err) {
      console.error("zoom webhook processing failed:", err);
      return { ok: true, outcome: "error" };
    }
  }

  const participant = meeting?.participant;
  const meetingId = meeting?.id;
  if (
    (body.event === "meeting.participant_joined" || body.event === "meeting.participant_left") &&
    payload.account_id && meetingId !== undefined && participant
  ) {
    try {
      const outcome = await recordZoomParticipantEvent({
        event: body.event,
        accountId: payload.account_id,
        meeting: {
          id: String(meetingId),
          uuid: meeting?.uuid || null,
          topic: meeting?.topic?.trim().slice(0, 200) || null,
          startTime: meeting?.start_time || null,
        },
        participant,
      });
      return { ok: true, outcome };
    } catch (err) {
      // Answer 200 anyway: Zoom disables endpoints that keep failing, and the report sweep repairs this.
      console.error("zoom webhook processing failed:", err);
      return { ok: true, outcome: "error" };
    }
  }
  return { ok: true, outcome: "ignored" };
});
