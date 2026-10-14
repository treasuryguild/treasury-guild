// An attendee confirms presence with the code the host shared. Any signed-in
// wallet may check in while the call runs: the code doubles as an invite, so
// the wallet joins the community as a member (it has to be one to be paid and
// to see its reward). One row per wallet per call, however often it is sent.
import { parseJson, sessionRoute } from "@/lib/api/route";
import { callCheckinSchema } from "@/lib/api/schemas";
import type { CallCheckinResponse } from "@/lib/api/types";
import { assertWalletOnCallNetwork } from "@/lib/calls/access";
import { checkinCodeMatches, checkinWindow } from "@/lib/calls/checkinCode";
import { AttendeeSource } from "@/lib/constants";
import {
  insertAttendeeOnce, loadCall, loadCallAttendees, loadCheckinCode, loadContributorName,
} from "@/lib/db/calls";
import { addMember } from "@/lib/db/membership";
import { enforceRateLimit } from "@/lib/db/rateLimit";
import { BadRequestError, ConflictError, NotFoundError } from "@/lib/errors";
import { shortAddress } from "@/lib/format";

export const POST = sessionRoute<{ id: string }>(async (req, { params, session }) => {
  const { wallet } = session;
  const { code } = await parseJson(req, callCheckinSchema);
  // Codes are guessable where call ids are not: cap the attempts per call.
  await enforceRateLimit("callCheckin", `${params.id}:${wallet}`);
  const call = await loadCall(params.id);
  // One answer for "no such call" and "wrong code": ids are not guessable, codes are.
  const stored = call ? await loadCheckinCode(call.id) : null;
  if (!call || !stored || !checkinCodeMatches(code, stored)) {
    throw new NotFoundError("That code does not match this call");
  }
  if (call.workgroups?.archived_at) throw new ConflictError("This call is archived");
  const window = checkinWindow(call, Date.now());
  if (window === "early") throw new BadRequestError("Check-in opens 15 minutes before the call starts");
  if (window === "closed") throw new BadRequestError("Check-in closed when the call ended");
  assertWalletOnCallNetwork(call, wallet);

  const response = (already: boolean) => ({
    title: call.title,
    communitySlug: call.workgroups?.communities?.slug ?? "",
    already,
  }) satisfies CallCheckinResponse;

  const attendees = await loadCallAttendees(call.id);
  if (attendees.some((a) => a.wallet_address === wallet)) return response(true);

  await addMember(call.community_id, wallet);
  const now = new Date().toISOString();
  const inserted = await insertAttendeeOnce({
    call_id: call.id,
    provider: AttendeeSource.Checkin,
    external_id: wallet,
    display_name: (await loadContributorName(wallet)) ?? shortAddress(wallet),
    wallet_address: wallet,
    first_seen: now,
    last_seen: now,
  });
  return response(!inserted);
});
