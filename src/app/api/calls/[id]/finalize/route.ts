// Turn a call's ready attendees into attendance task(s): native, payable, one
// 'manual' assignee per wallet, the call's reward as amounts. The threshold is
// applied here; finalize_call (migration 0037) does the writes atomically and
// skips anyone who already has a task, so a retry never pays twice. Attendees
// without a wallet stay on the list for a later finalize. The steps live in
// src/lib/calls/finalize.ts, shared with the agent API.
import { sessionRoute } from "@/lib/api/route";
import type { FinalizeCallResponse } from "@/lib/api/types";
import { loadCallForManager } from "@/lib/calls/access";
import { finalizeReady, planFinalize } from "@/lib/calls/finalize";

export const POST = sessionRoute<{ id: string }>(async (_req, { params, session }) => {
  const call = await loadCallForManager(params.id, session.wallet);
  const { ready } = await planFinalize(call);
  return { ...(await finalizeReady(call, session.wallet, ready)) } satisfies FinalizeCallResponse;
});
