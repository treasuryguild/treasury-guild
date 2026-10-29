// An attendee confirms presence with the code the host shared. Any signed-in
// wallet may check in while the call runs. On a public community the code
// doubles as an invite (join as member); a private community stays invite-
// only. Check-in attendees need a manager's confirm before they qualify for
// the reward. One row per wallet per call, however often it is sent.
import { parseJson, sessionRoute } from "@/lib/api/route";
import { callCheckinSchema } from "@/lib/api/schemas";
import type { CallCheckinResponse } from "@/lib/api/types";
import { memberRole } from "@/lib/authz";
import { assertWalletOnCallNetwork } from "@/lib/calls/access";
import { checkinCodeMatches, checkinWindow } from "@/lib/calls/checkinCode";
import { AttendeeSource, Visibility } from "@/lib/constants";
import {
  insertAttendeeOnce, loadCall, loadCallAttendees, loadCheckinCode, loadContributorName,
} from "@/lib/db/calls";
import { requireCommunity } from "@/lib/db/communities";
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

  // Public communities: the code is also an invite. Private ones stay
  // invite-only; an outsider can still sit on the attendee list for the
  // manager to confirm, but does not become a member from the code alone.
  const community = await requireCommunity(call.community_id);
  if (community.visibility === Visibility.Public || (await memberRole(call.community_id, wallet))) {
    await addMember(call.community_id, wallet);
  }
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
