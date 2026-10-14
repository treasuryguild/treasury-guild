// Call attendance reads and writes (service role only; the call tables have
// no client write policies). Attendance tasks are created by the
// finalize_call RPC alone (migration 0037), never row by row from here.
import "server-only";

import type { MemberOption } from "@/lib/boardTypes";
import { toMemberOptions } from "@/lib/boardTypes";
import type { NameMatchContext } from "@/lib/calls/nameMatch";
import { PgCode } from "@/lib/constants";
import { ConflictError } from "@/lib/errors";
import { isUuid } from "@/lib/guards";
import { check, maybe, must, optionalRelation, rows, rpc, serviceClient } from "./client";
import {
  CALL_ATTENDEE_COLUMNS,
  CALL_COLUMNS,
  MEMBER_WITH_CONTRIBUTOR_COLUMNS,
  type CallAttendeeRow,
  type CallRow,
  type MemberWithContributor,
} from "./types";

/** call_attendees_wallet_uq: the wallet is already on this call. */
const WALLET_TAKEN = "This wallet is already on the call's list";

export type CallWithWorkgroup = CallRow & {
  workgroups: { archived_at: string | null; communities: { slug: string; network: number } | null } | null;
};

export async function loadCall(callId: string): Promise<CallWithWorkgroup | null> {
  if (!isUuid(callId)) return null;
  return maybe<CallWithWorkgroup>(
    await serviceClient()
      .from("calls")
      .select(`${CALL_COLUMNS}, workgroups!inner(archived_at, communities!inner(slug, network))`)
      .eq("id", callId)
      .maybeSingle(),
    "load call",
  );
}

/** A call as the agent API lists it: its workgroup's name and its attendees (member-safe columns only). */
export type CallListing = CallRow & {
  workgroups: { name: string } | { name: string }[] | null;
  call_attendees: CallAttendeeRow[];
};

/**
 * The community's calls, newest first. Attendees are read with
 * CALL_ATTENDEE_COLUMNS, which leaves out the platform account ids members
 * never see (external_id, 0039): the service role must not widen that.
 */
export async function listCommunityCalls(
  communityId: string,
  filter: { state?: string; callId?: string; limit: number },
): Promise<CallListing[]> {
  let query = serviceClient()
    .from("calls")
    .select(`${CALL_COLUMNS}, workgroups(name), call_attendees(${CALL_ATTENDEE_COLUMNS})`)
    .eq("community_id", communityId);
  if (filter.state) query = query.eq("state", filter.state);
  if (filter.callId) query = query.eq("id", filter.callId);
  return rows<CallListing>(
    await query.order("starts_at", { ascending: false }).limit(filter.limit),
    "list community calls",
  );
}

export type NewCall = Pick<
  CallRow,
  "workgroup_id" | "provider" | "title" | "external_ref" | "starts_at" | "ends_at" | "amounts" | "min_snapshots" | "min_minutes" | "created_by"
>;

/** community_id is filled from the workgroup by calls_set_community. */
export async function insertCall(call: NewCall, communityId: string): Promise<CallRow> {
  return must<CallRow>(
    await serviceClient()
      .from("calls")
      .insert({ ...call, community_id: communityId })
      .select(CALL_COLUMNS)
      .single(),
    "insert call",
  );
}

/** insertCall keyed by an agent API draft (0065); null when that draft made its call already. */
export async function insertDraftCall(call: NewCall, communityId: string, draftId: string): Promise<CallRow | null> {
  const res = await serviceClient()
    .from("calls")
    .insert({ ...call, community_id: communityId, agent_draft_id: draftId })
    .select(CALL_COLUMNS)
    .single();
  if (res.error?.code === PgCode.UniqueViolation) return null;
  return must<CallRow>(res, "insert call");
}

/** The call an agent API draft created, if it created one. */
export async function findCallByDraft(draftId: string): Promise<CallRow | null> {
  return maybe<CallRow>(
    await serviceClient().from("calls").select(CALL_COLUMNS).eq("agent_draft_id", draftId).maybeSingle(),
    "find draft call",
  );
}

export async function updateCall(
  callId: string,
  patch: Partial<Pick<CallRow, "title" | "external_ref" | "starts_at" | "ends_at" | "amounts" | "min_snapshots" | "min_minutes">>,
): Promise<CallRow> {
  return must<CallRow>(
    await serviceClient().from("calls").update(patch).eq("id", callId).select(CALL_COLUMNS).single(),
    "update call",
  );
}

/**
 * Delete a call that has no attendance tasks (delete_call_without_tasks,
 * migration 0063: checked under the call row lock, so a finalize cannot slip
 * in between). 409 once it has tasks: it stays as their record.
 */
export async function deleteCallWithoutTasks(callId: string): Promise<void> {
  rpc(await serviceClient().rpc("delete_call_without_tasks", { p_call_id: callId }));
}

/** Set a call's reward while it has no attendance tasks (set_call_amounts, 0063); 409 once it has. */
export async function setCallAmounts(callId: string, amounts: Record<string, string>): Promise<CallRow> {
  const db = serviceClient();
  rpc(await db.rpc("set_call_amounts", { p_call_id: callId, p_amounts: amounts }));
  return must<CallRow>(await db.from("calls").select(CALL_COLUMNS).eq("id", callId).single(), "load call");
}

export async function loadCallAttendees(callId: string): Promise<CallAttendeeRow[]> {
  return rows<CallAttendeeRow>(
    await serviceClient()
      .from("call_attendees")
      .select(CALL_ATTENDEE_COLUMNS)
      .eq("call_id", callId)
      .order("created_at")
      .order("id"),
    "load call attendees",
  );
}

export async function loadCallAttendee(
  callId: string,
  attendeeId: string,
): Promise<CallAttendeeRow | null> {
  return maybe<CallAttendeeRow>(
    await serviceClient()
      .from("call_attendees")
      .select(CALL_ATTENDEE_COLUMNS)
      .eq("call_id", callId)
      .eq("id", attendeeId)
      .maybeSingle(),
    "load call attendee",
  );
}

export type NewAttendee = Pick<CallAttendeeRow, "call_id" | "provider" | "display_name"> &
  Partial<Pick<CallAttendeeRow, "wallet_address" | "status" | "first_seen" | "last_seen">> & {
    /** Platform account id (check-in: the wallet). Write-only from here. */
    external_id?: string | null;
  };

/** Insert rows the caller already de-duplicated against the call's list. */
export async function insertAttendees(attendees: NewAttendee[]): Promise<void> {
  if (attendees.length === 0) return;
  const { error } = await serviceClient().from("call_attendees").insert(attendees);
  if (error?.code === PgCode.UniqueViolation) throw new ConflictError(WALLET_TAKEN);
  check({ error }, "insert call attendees");
}

/**
 * Insert one attendee; false when the wallet (or platform identity) is
 * already on the call, which a concurrent check-in can cause.
 */
export async function insertAttendeeOnce(attendee: NewAttendee): Promise<boolean> {
  const { error } = await serviceClient().from("call_attendees").insert(attendee);
  if (error?.code === PgCode.UniqueViolation) return false;
  check({ error }, "insert call attendee");
  return true;
}

export async function updateAttendee(
  attendeeId: string,
  patch: Partial<Pick<CallAttendeeRow, "wallet_address" | "status">>,
): Promise<void> {
  const { error } = await serviceClient().from("call_attendees").update(patch).eq("id", attendeeId);
  if (error?.code === PgCode.UniqueViolation) throw new ConflictError(WALLET_TAKEN);
  check({ error }, "update call attendee");
}

export async function deleteAttendee(attendeeId: string): Promise<void> {
  check(
    await serviceClient().from("call_attendees").delete().eq("id", attendeeId),
    "delete call attendee",
  );
}

/** Remembered name -> wallet matches of the community. */
export async function loadNameAliases(communityId: string): Promise<Map<string, string>> {
  const aliases = rows<{ normalized_name: string; wallet_address: string }>(
    await serviceClient()
      .from("call_name_aliases")
      .select("normalized_name, wallet_address")
      .eq("community_id", communityId),
    "load call name aliases",
  );
  return new Map(aliases.map((a) => [a.normalized_name, a.wallet_address]));
}

export async function saveNameAlias(alias: {
  community_id: string;
  normalized_name: string;
  wallet_address: string;
  created_by: string;
}): Promise<void> {
  check(
    await serviceClient()
      .from("call_name_aliases")
      .upsert(alias, { onConflict: "community_id,normalized_name" }),
    "save call name alias",
  );
}

/** The community's members as name-matching candidates. */
/** What a guest's display name is matched against: the community's aliases and members. */
export async function loadNameMatchContext(communityId: string): Promise<NameMatchContext> {
  const [aliases, members] = await Promise.all([loadNameAliases(communityId), loadMemberOptions(communityId)]);
  return { aliases, members };
}

export async function loadMemberOptions(communityId: string): Promise<MemberOption[]> {
  const members = rows<MemberWithContributor>(
    await serviceClient()
      .from("community_members")
      .select(MEMBER_WITH_CONTRIBUTOR_COLUMNS)
      .eq("community_id", communityId),
    "load community members",
  );
  return toMemberOptions(
    members.map((m) => ({
      wallet_address: m.wallet_address,
      // supabase-js infers a to-one embed as an array.
      contributors: optionalRelation(m.contributors),
    })),
  );
}

/** The contributor's own display name (handle, else GitHub login), if any. */
export async function loadContributorName(wallet: string): Promise<string | null> {
  const profile = maybe<{ handle: string | null; github_username: string | null }>(
    await serviceClient()
      .from("contributors")
      .select("handle, github_username")
      .eq("wallet_address", wallet)
      .maybeSingle(),
    "load contributor",
  );
  return profile?.handle || profile?.github_username || null;
}

export async function loadCheckinCode(callId: string): Promise<string | null> {
  const row = maybe<{ code: string }>(
    await serviceClient().from("call_checkin_codes").select("code").eq("call_id", callId).maybeSingle(),
    "load check-in code",
  );
  return row?.code ?? null;
}

/** Replace the call's code; the previous one stops working at once. */
export async function setCheckinCode(callId: string, code: string, actor: string): Promise<void> {
  check(
    await serviceClient()
      .from("call_checkin_codes")
      .upsert(
        { call_id: callId, code, created_by: actor, created_at: new Date().toISOString() },
        { onConflict: "call_id" },
      ),
    "set check-in code",
  );
}

export async function clearCheckinCode(callId: string): Promise<void> {
  check(
    await serviceClient().from("call_checkin_codes").delete().eq("call_id", callId),
    "clear check-in code",
  );
}

export interface FinalizeCallResult {
  taskIds: string[];
  /** Attendees placed on the new tasks. */
  paid: number;
  /** Attendees still without a task (unlinked or below the threshold). */
  remaining: number;
}

/** Create the attendance task(s); safe to repeat (see finalize_call). */
export async function finalizeCall(args: {
  callId: string;
  actor: string;
  attendeeIds: string[];
  chunk: number;
  bountyLovelace: string | null;
  /** The reward the bounty was derived from: refused (409) if the call's changed since. */
  amounts: Record<string, string>;
}): Promise<FinalizeCallResult> {
  return rpc<FinalizeCallResult>(
    await serviceClient().rpc("finalize_call_at_reward", {
      p_call_id: args.callId,
      p_actor: args.actor,
      p_attendee_ids: args.attendeeIds,
      p_chunk: args.chunk,
      p_bounty_lovelace: args.bountyLovelace,
      p_amounts: args.amounts,
    }),
    { [PgCode.UniqueViolation]: ConflictError },
  );
}
