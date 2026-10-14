// Create a rewarded call in a workgroup. Admins and the workgroup's leads.
// Reads go through RLS in the browser (members see calls and attendees).
import { parseJson, sessionRoute } from "@/lib/api/route";
import { createCallSchema } from "@/lib/api/schemas";
import type { CallResponse } from "@/lib/api/types";
import { createCall } from "@/lib/calls/create";
import { InvariantError } from "@/lib/errors";

export const POST = sessionRoute(async (req, { session }) => {
  const body = await parseJson(req, createCallSchema);
  const call = await createCall(body, session.wallet);
  if (!call) throw new InvariantError("create call: no row");
  return { call } satisfies CallResponse;
});
