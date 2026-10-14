// Call capture reads and writes (service role only): a community's platform
// connections and their tokens, the snapshots of a Discord call's voice
// channel and the presence sessions of a Zoom / Meet call. Evidence is
// recorded by the record_call_snapshot / record_call_sessions RPCs alone
// (migrations 0039, 0040), which resolve each person to one attendee row and
// recompute presence.
import "server-only";

import { sha256Hex } from "@/lib/auth/crypto";
import type { PresentUser } from "@/lib/calls/discordSnapshot";
import type { PendingMeetingEvent, PresenceSession } from "@/lib/calls/zoomSessions";
import { type CallProvider, CallState, IntegrationProvider, PgCode } from "@/lib/constants";
import { ConflictError } from "@/lib/errors";
import { isUuid } from "@/lib/guards";
import { check, maybe, must, rows, rpc, serviceClient } from "./client";
import {
  CALL_COLUMNS, CALL_INTEGRATION_RECORD_COLUMNS, CALL_MEETING_LINK_COLUMNS,
  type CallIntegrationRecord, type CallMeetingLinkRow, type CallRow,
} from "./types";



export async function loadIntegration(
  communityId: string,
  provider: IntegrationProvider,
): Promise<CallIntegrationRecord | null> {
  return maybe<CallIntegrationRecord>(
    await serviceClient()
      .from("call_integrations")
      .select(CALL_INTEGRATION_RECORD_COLUMNS)
      .eq("community_id", communityId)
      .eq("provider", provider)
      .maybeSingle(),
    "load call integration",
  );
}

/**
 * Connect (or re-point) the community's account on a platform together with
 * its tokens, in one step (save_call_integration, migration 0063): a row never
 * names one account while holding another's tokens. `secrets` null (Discord)
 * drops any stored ones.
 */
export async function saveIntegration(
  integration: {
    community_id: string;
    provider: IntegrationProvider;
    external_account_id: string;
    label: string | null;
    created_by: string;
  },
  secrets: IntegrationSecrets | null,
): Promise<{ id: string }> {
  const id = rpc<string>(
    await serviceClient().rpc("save_call_integration", {
      p_community_id: integration.community_id,
      p_provider: integration.provider,
      p_external_account_id: integration.external_account_id,
      p_label: integration.label,
      p_created_by: integration.created_by,
      p_access_token: secrets?.access_token ?? null,
      p_refresh_token: secrets?.refresh_token ?? null,
      p_expires_at: secrets?.expires_at ?? null,
    }),
  );
  return { id };
}

export async function deleteIntegration(integrationId: string): Promise<void> {
  check(
    await serviceClient().from("call_integrations").delete().eq("id", integrationId),
    "delete call integration",
  );
}

/** Whether another community is connected to the same platform account. */
export async function accountConnectedElsewhere(
  provider: IntegrationProvider,
  externalAccountId: string,
): Promise<boolean> {
  const found = rows<{ id: string }>(
    await serviceClient()
      .from("call_integrations")
      .select("id")
      .eq("provider", provider)
      .eq("external_account_id", externalAccountId)
      .limit(1),
    "load integrations of account",
  );
  return found.length > 0;
}

export async function latestSnapshotAt(callId: string): Promise<string | null> {
  const row = maybe<{ taken_at: string }>(
    await serviceClient()
      .from("call_snapshots")
      .select("taken_at")
      .eq("call_id", callId)
      .order("taken_at", { ascending: false })
      .limit(1)
      .maybeSingle(),
    "load latest snapshot",
  );
  return row?.taken_at ?? null;
}

export type CapturableCall = Pick<CallRow, "id" | "community_id" | "title" | "external_ref" | "starts_at" | "ends_at">;

/**
 * Calls of a platform that are running right now and name what they are
 * captured from: open, inside starts_at..ends_at, in an active workgroup.
 * Oldest start first, so a bounded batch never starves a call about to end.
 */
export async function loadRunningCalls(
  provider: CallProvider,
  now: Date,
  limit: number,
): Promise<ReportableCall[]> {
  const iso = now.toISOString();
  return rows<ReportableCall>(
    await serviceClient()
      .from("calls")
      .select("id, community_id, title, external_ref, external_instance, starts_at, ends_at, workgroups!inner(archived_at)")
      .eq("provider", provider)
      .eq("state", CallState.Open)
      .not("external_ref", "is", null)
      .lte("starts_at", iso)
      .gte("ends_at", iso)
      .is("workgroups.archived_at", null)
      .order("starts_at")
      .limit(limit),
    "load running calls",
  );
}

/** Guild id per community, for the communities that connected Discord. */
export async function loadDiscordGuilds(communityIds: string[]): Promise<Map<string, string>> {
  if (communityIds.length === 0) return new Map();
  const found = rows<{ community_id: string; external_account_id: string }>(
    await serviceClient()
      .from("call_integrations")
      .select("community_id, external_account_id")
      .eq("provider", IntegrationProvider.Discord)
      .in("community_id", communityIds),
    "load discord guilds",
  );
  return new Map(found.map((i) => [i.community_id, i.external_account_id]));
}

/** Every Discord server some community is connected to (the orphan sweep keeps the bot in these). */
export async function loadConnectedDiscordGuilds(): Promise<Set<string>> {
  const found = rows<{ external_account_id: string }>(
    await serviceClient()
      .from("call_integrations")
      .select("external_account_id")
      .eq("provider", IntegrationProvider.Discord),
    "load connected discord guilds",
  );
  return new Set(found.map((i) => i.external_account_id));
}

export interface SnapshotResult {
  snapshotId: string;
  /** People in the channel. */
  present: number;
  /** Of them, new to the call's list. */
  added: number;
}

export async function recordSnapshot(
  callId: string,
  source: "manual" | "cron",
  present: PresentUser[],
): Promise<SnapshotResult> {
  return rpc<SnapshotResult>(
    await serviceClient().rpc("record_call_snapshot", {
      p_call_id: callId,
      p_source: source,
      p_present: present,
    }),
  );
}

// --- Minutes-based capture (Zoom, Meet): tokens, sessions, the report sweep ---

export interface IntegrationSecrets {
  access_token: string;
  refresh_token: string;
  /** ISO timestamp. */
  expires_at: string;
}

export async function loadIntegrationSecrets(integrationId: string): Promise<IntegrationSecrets | null> {
  return maybe<IntegrationSecrets>(
    await serviceClient()
      .from("call_integration_secrets")
      .select("access_token, refresh_token, expires_at")
      .eq("integration_id", integrationId)
      .maybeSingle(),
    "load integration secrets",
  );
}

export async function saveIntegrationSecrets(integrationId: string, secrets: IntegrationSecrets): Promise<void> {
  check(
    await serviceClient()
      .from("call_integration_secrets")
      .upsert(
        { integration_id: integrationId, ...secrets, updated_at: new Date().toISOString() },
        { onConflict: "integration_id" },
      ),
    "save integration secrets",
  );
}

/** Every community connected to this platform account (the same host account may serve several). */
export async function loadIntegrationsByAccount(
  provider: IntegrationProvider,
  externalAccountId: string,
): Promise<CallIntegrationRecord[]> {
  return rows<CallIntegrationRecord>(
    await serviceClient()
      .from("call_integrations")
      .select(CALL_INTEGRATION_RECORD_COLUMNS)
      .eq("provider", provider)
      .eq("external_account_id", externalAccountId),
    "load integrations of account",
  );
}

/** The account revoked the app: forget it everywhere (tokens cascade). */
export async function deleteIntegrationsByAccount(
  provider: IntegrationProvider,
  externalAccountId: string,
): Promise<void> {
  check(
    await serviceClient()
      .from("call_integrations")
      .delete()
      .eq("provider", provider)
      .eq("external_account_id", externalAccountId),
    "delete integrations of account",
  );
  if (provider === "zoom") {
    check(
      await serviceClient()
        .from("call_pending_sessions")
        .delete()
        .eq("provider", provider)
        .eq("external_account_id", externalAccountId),
      "delete pending sessions of account",
    );
  }
}

/** A meeting id is reused (recurring meetings, personal rooms): the call is the one happening around `at`. */
const MEETING_MATCH_SLACK_MS = 30 * 60 * 1000;

export async function findCallForMeeting(args: {
  communityIds: string[];
  provider: CallProvider;
  meetingId: string;
  at: Date;
}): Promise<CapturableCall | null> {
  if (args.communityIds.length === 0) return null;
  const found = rows<CapturableCall>(
    await serviceClient()
      .from("calls")
      .select("id, community_id, title, external_ref, starts_at, ends_at, workgroups!inner(archived_at)")
      .eq("provider", args.provider)
      .eq("state", CallState.Open)
      .eq("external_ref", args.meetingId)
      .in("community_id", args.communityIds)
      .lte("starts_at", new Date(args.at.getTime() + MEETING_MATCH_SLACK_MS).toISOString())
      .gte("ends_at", new Date(args.at.getTime() - MEETING_MATCH_SLACK_MS).toISOString())
      .is("workgroups.archived_at", null)
      .order("starts_at", { ascending: false })
      .limit(1),
    "find call for meeting",
  );
  return found[0] ?? null;
}

// --- Events that arrived before their call existed (migration 0042) ---

/** Unclaimed events are deleted after this long. */
const PENDING_KEEP_MS = 24 * 60 * 60 * 1000;

interface PendingSessionRow {
  id: string;
  participant_key: string;
  display_name: string;
  joined_at: string | null;
  left_at: string | null;
  source_key: string | null;
}

export interface PendingSession {
  id: string;
  /** No wallet yet: names are matched when the event is replayed into a call. */
  session: Omit<PresenceSession, "wallet">;
}

/** Park an event of a connected account that matches no call (yet). A redelivered join lands on its row. */
export async function savePendingSession(
  provider: "zoom",
  externalAccountId: string,
  meeting: { ref: string; instance: string | null; topic: string | null },
  session: PresenceSession,
): Promise<void> {
  check(
    await serviceClient()
      .from("call_pending_sessions")
      .upsert(
        {
          provider,
          external_account_id: externalAccountId,
          meeting_ref: meeting.ref,
          meeting_instance: meeting.instance,
          topic: meeting.topic,
          participant_key: session.key,
          display_name: session.name,
          joined_at: session.joined,
          left_at: session.left,
          source_key: session.source,
        },
        { onConflict: "source_key", ignoreDuplicates: true },
      ),
    "save pending session",
  );
}

/** Parked events of the call's meeting that happened around the call (the window `findCallForMeeting` uses). */
export async function loadPendingSessions(
  provider: "zoom",
  externalAccountId: string,
  call: Pick<CapturableCall, "external_ref" | "starts_at" | "ends_at">,
): Promise<PendingSession[]> {
  if (!call.external_ref) return [];
  const from = new Date(Date.parse(call.starts_at) - MEETING_MATCH_SLACK_MS).toISOString();
  const to = new Date(Date.parse(call.ends_at) + MEETING_MATCH_SLACK_MS).toISOString();
  const found = rows<PendingSessionRow>(
    await serviceClient()
      .from("call_pending_sessions")
      .select("id, participant_key, display_name, joined_at, left_at, source_key")
      .eq("provider", provider)
      .eq("external_account_id", externalAccountId)
      .eq("meeting_ref", call.external_ref)
      .or(
        `and(joined_at.gte."${from}",joined_at.lte."${to}"),` +
        `and(joined_at.is.null,left_at.gte."${from}",left_at.lte."${to}")`,
      ),
    "load pending sessions",
  );
  return found.map((r) => ({
    id: r.id,
    session: { key: r.participant_key, name: r.display_name, joined: r.joined_at, left: r.left_at, source: r.source_key },
  }));
}

/** Everything parked for the account, as the detected-meetings list groups it. */
export async function loadPendingMeetingEvents(
  provider: "zoom",
  externalAccountId: string,
): Promise<PendingMeetingEvent[]> {
  const found = rows<{
    meeting_ref: string; meeting_instance: string | null; topic: string | null;
    participant_key: string; joined_at: string | null; left_at: string | null;
  }>(
    await serviceClient()
      .from("call_pending_sessions")
      .select("meeting_ref, meeting_instance, topic, participant_key, joined_at, left_at")
      .eq("provider", provider)
      .eq("external_account_id", externalAccountId),
    "load pending meeting events",
  );
  return found.map((r) => ({
    meetingRef: r.meeting_ref, instance: r.meeting_instance, topic: r.topic,
    key: r.participant_key, joined: r.joined_at, left: r.left_at,
  }));
}

export async function deletePendingSessions(ids: string[]): Promise<void> {
  if (ids.length === 0) return;
  check(await serviceClient().from("call_pending_sessions").delete().in("id", ids), "delete pending sessions");
}

/** Forget events nobody claimed: they belong to meetings that were never listed as calls. */
export async function purgePendingSessions(now: Date): Promise<void> {
  check(
    await serviceClient()
      .from("call_pending_sessions")
      .delete()
      .lt("received_at", new Date(now.getTime() - PENDING_KEEP_MS).toISOString()),
    "purge pending sessions",
  );
}

/** A delivery's signature hash stays this long: the signature window is ±5 minutes. */
const ZOOM_DELIVERY_KEEP_MS = 10 * 60 * 1000;

/**
 * Record a verified Zoom delivery; false when the same signed request was
 * already handled (a replay). Only a hash of the signature is kept (0047).
 */
export async function markZoomDeliverySeen(signature: string): Promise<boolean> {
  const { error } = await serviceClient()
    .from("zoom_webhook_deliveries")
    .insert({ signature_hash: sha256Hex(signature) });
  if (error?.code === PgCode.UniqueViolation) return false;
  check({ error }, "record zoom delivery");
  return true;
}

export async function purgeZoomDeliveries(now: Date): Promise<void> {
  check(
    await serviceClient()
      .from("zoom_webhook_deliveries")
      .delete()
      .lt("received_at", new Date(now.getTime() - ZOOM_DELIVERY_KEEP_MS).toISOString()),
    "purge zoom deliveries",
  );
}

export interface SessionsResult {
  /** Sessions recorded or refreshed. */
  sessions: number;
  /** People new to the call's list. */
  added: number;
}

export async function recordSessions(
  callId: string,
  provider: "zoom" | "meet",
  sessions: PresenceSession[],
): Promise<SessionsResult> {
  return rpc<SessionsResult>(
    await serviceClient().rpc("record_call_sessions", {
      p_call_id: callId,
      p_provider: provider,
      p_sessions: sessions,
    }),
  );
}

/** Bring minutes up to date (open sessions count up to now) before deciding who qualifies. */
export async function recomputeCallMinutes(callId: string): Promise<void> {
  check(await serviceClient().rpc("recompute_call_minutes", { p_call_id: callId }), "recompute call minutes");
}

/** The report appears a few minutes after a meeting ends; after a day it is not coming. */
const REPORT_DELAY_MS = 10 * 60 * 1000;
const REPORT_GIVE_UP_MS = 24 * 60 * 60 * 1000;

/** Ended calls of the platform whose participant report has not been read yet, oldest first. */
/**
 * `external_instance`: the occurrence a call that created itself belongs to
 * (Zoom's meeting uuid, Meet's conference record name).
 */
export type ReportableCall = CapturableCall & { external_instance: string | null };

export async function loadCallsAwaitingReport(
  provider: CallProvider,
  now: Date,
  limit: number,
): Promise<ReportableCall[]> {
  return rows<ReportableCall>(
    await serviceClient()
      .from("calls")
      .select("id, community_id, title, external_ref, external_instance, starts_at, ends_at, workgroups!inner(archived_at)")
      .eq("provider", provider)
      .eq("state", CallState.Open)
      .is("captured_at", null)
      .not("external_ref", "is", null)
      .lte("ends_at", new Date(now.getTime() - REPORT_DELAY_MS).toISOString())
      .gte("ends_at", new Date(now.getTime() - REPORT_GIVE_UP_MS).toISOString())
      .is("workgroups.archived_at", null)
      .order("ends_at")
      .limit(limit),
    "load calls awaiting report",
  );
}

export async function markCallCaptured(callId: string): Promise<void> {
  check(
    await serviceClient().from("calls").update({ captured_at: new Date().toISOString() }).eq("id", callId),
    "mark call captured",
  );
}

// --- Linked meetings: calls that create themselves (migration 0043) ---

export async function loadMeetingLinks(communityId: string): Promise<CallMeetingLinkRow[]> {
  return rows<CallMeetingLinkRow>(
    await serviceClient()
      .from("call_meeting_links")
      .select(CALL_MEETING_LINK_COLUMNS)
      .eq("community_id", communityId)
      .order("created_at"),
    "load meeting links",
  );
}

export async function loadMeetingLink(linkId: string): Promise<CallMeetingLinkRow | null> {
  if (!isUuid(linkId)) return null;
  return maybe<CallMeetingLinkRow>(
    await serviceClient().from("call_meeting_links").select(CALL_MEETING_LINK_COLUMNS).eq("id", linkId).maybeSingle(),
    "load meeting link",
  );
}

/** The link that claims this meeting among the given communities, in an active workgroup. Oldest wins. */
export async function findMeetingLink(
  communityIds: string[],
  provider: "zoom",
  meetingRef: string,
): Promise<CallMeetingLinkRow | null> {
  if (communityIds.length === 0) return null;
  const found = rows<CallMeetingLinkRow>(
    await serviceClient()
      .from("call_meeting_links")
      .select(`${CALL_MEETING_LINK_COLUMNS}, workgroups!inner(archived_at)`)
      .eq("provider", provider)
      .eq("meeting_ref", meetingRef)
      .in("community_id", communityIds)
      .is("workgroups.archived_at", null)
      .order("created_at")
      .limit(1),
    "find meeting link",
  );
  return found[0] ?? null;
}

/**
 * A platform's links in active workgroups, oldest first: what the Meet sweep
 * looks for new conferences of (Zoom links are found per event instead).
 */
export async function loadActiveMeetingLinks(
  provider: CallMeetingLinkRow["provider"],
  limit: number,
): Promise<CallMeetingLinkRow[]> {
  return rows<CallMeetingLinkRow>(
    await serviceClient()
      .from("call_meeting_links")
      .select(`${CALL_MEETING_LINK_COLUMNS}, workgroups!inner(archived_at)`)
      .eq("provider", provider)
      .is("workgroups.archived_at", null)
      .order("created_at")
      .limit(limit),
    "load active meeting links",
  );
}

/**
 * Which of these occurrences already have a call in the community, in any
 * state: a finalized occurrence must not be created again
 * (`findCallByInstance` sees open calls only).
 */
export async function loadKnownInstances(
  communityId: string,
  provider: CallProvider,
  instances: string[],
): Promise<Set<string>> {
  if (instances.length === 0) return new Set();
  const found = rows<{ external_instance: string }>(
    await serviceClient()
      .from("calls")
      .select("external_instance")
      .eq("community_id", communityId)
      .eq("provider", provider)
      .in("external_instance", instances),
    "load known instances",
  );
  return new Set(found.map((c) => c.external_instance));
}

export type NewMeetingLink = Pick<
  CallMeetingLinkRow,
  "workgroup_id" | "provider" | "meeting_ref" | "title" | "amounts" | "min_minutes" | "duration_minutes" | "created_by"
>;

/** community_id is filled from the workgroup by the table's trigger. */
export async function insertMeetingLink(link: NewMeetingLink, communityId: string): Promise<CallMeetingLinkRow> {
  const { data, error } = await serviceClient()
    .from("call_meeting_links")
    .insert({ ...link, community_id: communityId })
    .select(CALL_MEETING_LINK_COLUMNS)
    .single();
  if (error?.code === PgCode.UniqueViolation) throw new ConflictError("This meeting is already linked to a workgroup");
  return must<CallMeetingLinkRow>({ data, error }, "insert meeting link");
}

export async function updateMeetingLink(
  linkId: string,
  patch: Partial<Pick<CallMeetingLinkRow, "title" | "amounts" | "min_minutes" | "duration_minutes">>,
): Promise<CallMeetingLinkRow> {
  return must<CallMeetingLinkRow>(
    await serviceClient().from("call_meeting_links").update(patch).eq("id", linkId).select(CALL_MEETING_LINK_COLUMNS).single(),
    "update meeting link",
  );
}

export async function deleteMeetingLink(linkId: string): Promise<void> {
  check(await serviceClient().from("call_meeting_links").delete().eq("id", linkId), "delete meeting link");
}

/** The open call created for this occurrence of a meeting (Zoom's meeting uuid), if any. */
export async function findCallByInstance(
  communityIds: string[],
  provider: CallProvider,
  instance: string,
): Promise<CapturableCall | null> {
  if (communityIds.length === 0) return null;
  const found = rows<CapturableCall>(
    await serviceClient()
      .from("calls")
      .select("id, community_id, title, external_ref, starts_at, ends_at")
      .eq("provider", provider)
      .eq("state", CallState.Open)
      .eq("external_instance", instance)
      .in("community_id", communityIds)
      .limit(1),
    "find call by instance",
  );
  return found[0] ?? null;
}

/**
 * Create the call of a linked meeting's occurrence. Null when another event
 * of the same occurrence created it a moment ago (calls_external_instance_uq):
 * the caller looks it up again.
 */
export async function insertLinkedCall(
  link: CallMeetingLinkRow,
  occurrence: { instance: string; startsAt: string; endsAt: string },
): Promise<CallRow | null> {
  const { data, error } = await serviceClient()
    .from("calls")
    .insert({
      community_id: link.community_id,
      workgroup_id: link.workgroup_id,
      provider: link.provider,
      title: link.title,
      external_ref: link.meeting_ref,
      external_instance: occurrence.instance,
      meeting_link_id: link.id,
      starts_at: occurrence.startsAt,
      ends_at: occurrence.endsAt,
      amounts: link.amounts,
      min_minutes: link.min_minutes,
      created_by: link.created_by,
    })
    .select(CALL_COLUMNS)
    .single();
  if (error?.code === PgCode.UniqueViolation) return null;
  return must<CallRow>({ data, error }, "insert linked call");
}

/** Move the end of a call that created itself: the meeting ran longer, or Zoom said when it ended. */
export async function setCallEnd(callId: string, endsAt: string): Promise<void> {
  check(
    // Never before the start (calls check: ends_at > starts_at).
    await serviceClient().from("calls").update({ ends_at: endsAt }).eq("id", callId).lt("starts_at", endsAt),
    "set call end",
  );
}
