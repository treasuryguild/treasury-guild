// The call's check-in code, for the managers who share it. GET shows the
// current one, POST replaces it (the old code stops working), DELETE closes
// check-in. The code never travels through RLS reads.
import { sessionRoute } from "@/lib/api/route";
import type { CheckinCodeResponse } from "@/lib/api/types";
import { loadCallForManager } from "@/lib/calls/access";
import { generateCheckinCode } from "@/lib/calls/checkinCode";
import { clearCheckinCode, loadCheckinCode, setCheckinCode } from "@/lib/db/calls";

export const GET = sessionRoute<{ id: string }>(async (_req, { params, session }) => {
  const call = await loadCallForManager(params.id, session.wallet);
  return { code: await loadCheckinCode(call.id) } satisfies CheckinCodeResponse;
});

export const POST = sessionRoute<{ id: string }>(async (_req, { params, session }) => {
  const call = await loadCallForManager(params.id, session.wallet);
  const code = generateCheckinCode();
  await setCheckinCode(call.id, code, session.wallet);
  return { code } satisfies CheckinCodeResponse;
});

export const DELETE = sessionRoute<{ id: string }>(async (_req, { params, session }) => {
  const call = await loadCallForManager(params.id, session.wallet);
  await clearCheckinCode(call.id);
  return { code: null } satisfies CheckinCodeResponse;
});
