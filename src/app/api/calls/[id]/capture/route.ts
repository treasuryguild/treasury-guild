// Take a snapshot of a Discord call's voice channel now. Admins and the
// workgroup's leads, while the call runs (the calls-sync cron does the same
// every few minutes; this is for "everyone is here, capture it").
import { sessionRoute } from "@/lib/api/route";
import type { CaptureCallResponse } from "@/lib/api/types";
import { loadCallForManager } from "@/lib/calls/access";
import { captureCallNow } from "@/lib/calls/capture";
import { checkinWindow } from "@/lib/calls/checkinCode";
import { CallProvider } from "@/lib/constants";
import { BadRequestError } from "@/lib/errors";

export const POST = sessionRoute<{ id: string }>(async (_req, { params, session }) => {
  const call = await loadCallForManager(params.id, session.wallet);
  if (call.provider !== CallProvider.Discord) {
    throw new BadRequestError("Only Discord calls are captured from a voice channel");
  }
  // Same window as check-in: from shortly before the start until the end.
  if (checkinWindow(call, Date.now()) !== "open") {
    throw new BadRequestError("Snapshots are taken while the call runs");
  }
  const { present, added } = await captureCallNow(call);
  return { present, added } satisfies CaptureCallResponse;
});
