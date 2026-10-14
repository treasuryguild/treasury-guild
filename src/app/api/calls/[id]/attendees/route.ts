// A call's attendee list, edited by admins and the workgroup's leads.
// POST adds a pasted name list (matched to members where unambiguous) or one
// wallet; PATCH links a wallet or sets the status; DELETE removes a row.
// An attendee that is already on an attendance task is that task's record:
// change the task instead (or delete it, which frees the attendee).
import { parseJson, sessionRoute } from "@/lib/api/route";
import { addAttendeesSchema, deleteAttendeeSchema, patchAttendeeSchema } from "@/lib/api/schemas";
import type { AddAttendeesResponse, OkResponse } from "@/lib/api/types";
import { shortAddress } from "@/lib/format";
import { assertWalletOnCallNetwork, loadCallForManager } from "@/lib/calls/access";
import { matchName, normalizeName } from "@/lib/calls/nameMatch";
import { AttendeeSource } from "@/lib/constants";
import {
  deleteAttendee,
  insertAttendees,
  loadCallAttendee,
  loadCallAttendees,
  loadMemberOptions,
  loadNameAliases,
  saveNameAlias,
  updateAttendee,
  type NewAttendee,
} from "@/lib/db/calls";
import { ensureContributor } from "@/lib/db/membership";
import { ConflictError, NotFoundError } from "@/lib/errors";

const REWARDED = "This attendee is already on an attendance task";

export const POST = sessionRoute<{ id: string }>(async (req, { params, session }) => {
  const body = await parseJson(req, addAttendeesSchema);
  const call = await loadCallForManager(params.id, session.wallet);
  const existing = await loadCallAttendees(call.id);
  const wallets = new Set(existing.map((a) => a.wallet_address).filter((w): w is string => !!w));

  if (body.kind === "wallet") {
    if (wallets.has(body.wallet)) throw new ConflictError("This wallet is already on the call's list");
    assertWalletOnCallNetwork(call, body.wallet);
    await ensureContributor(body.wallet);
    await insertAttendees([{
      call_id: call.id,
      provider: AttendeeSource.Manual,
      display_name: shortAddress(body.wallet),
      wallet_address: body.wallet,
    }]);
    return { added: 1, matched: 1, skipped: 0 } satisfies AddAttendeesResponse;
  }

  const [aliases, members] = await Promise.all([
    loadNameAliases(call.community_id),
    loadMemberOptions(call.community_id),
  ]);
  const names = new Set(existing.map((a) => normalizeName(a.display_name)));
  const added: NewAttendee[] = [];
  let matched = 0;
  for (const name of body.names) {
    const key = normalizeName(name);
    const wallet = matchName(name, { aliases, members });
    // Same name or same person again: one row, one reward.
    if (!key || names.has(key) || (wallet && wallets.has(wallet))) continue;
    names.add(key);
    if (wallet) {
      wallets.add(wallet);
      matched += 1;
    }
    added.push({
      call_id: call.id,
      provider: AttendeeSource.Manual,
      display_name: name,
      wallet_address: wallet,
    });
  }
  await insertAttendees(added);
  return {
    added: added.length,
    matched,
    skipped: body.names.length - added.length,
  } satisfies AddAttendeesResponse;
});

export const PATCH = sessionRoute<{ id: string }>(async (req, { params, session }) => {
  const body = await parseJson(req, patchAttendeeSchema);
  const call = await loadCallForManager(params.id, session.wallet);
  const attendee = await loadCallAttendee(call.id, body.attendeeId);
  if (!attendee) throw new NotFoundError("Attendee not found");
  if (attendee.task_id) throw new ConflictError(REWARDED);

  if (body.wallet) {
    assertWalletOnCallNetwork(call, body.wallet);
    await ensureContributor(body.wallet);
  }
  await updateAttendee(attendee.id, {
    ...(body.wallet !== undefined && { wallet_address: body.wallet }),
    ...(body.status !== undefined && { status: body.status }),
  });
  const key = normalizeName(attendee.display_name);
  if (body.wallet && body.remember && key) {
    await saveNameAlias({
      community_id: call.community_id,
      normalized_name: key,
      wallet_address: body.wallet,
      created_by: session.wallet,
    });
  }
  return { ok: true } satisfies OkResponse;
});

export const DELETE = sessionRoute<{ id: string }>(async (req, { params, session }) => {
  const { attendeeId } = await parseJson(req, deleteAttendeeSchema);
  const call = await loadCallForManager(params.id, session.wallet);
  const attendee = await loadCallAttendee(call.id, attendeeId);
  if (!attendee) throw new NotFoundError("Attendee not found");
  if (attendee.task_id) throw new ConflictError(REWARDED);
  await deleteAttendee(attendee.id);
  return { ok: true } satisfies OkResponse;
});
