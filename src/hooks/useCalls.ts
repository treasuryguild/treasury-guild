"use client";

import { browserClient } from "@/lib/supabase/browser";
import {
  CALL_ATTENDEES_EMBED,
  CALL_COLUMNS,
  CALL_TASKS_EMBED,
  type CallAttendee,
  type CallAttendeeRow,
  CALL_INTEGRATION_COLUMNS,
  type CallIntegrationRow,
  CALL_MEETING_LINK_COLUMNS,
  type CallMeetingLinkRow,
  type CallRow,
  type CallSnapshotRow,
  type CallTaskLink,
} from "@/lib/db/types";
import { useAsyncData, type AsyncData } from "./useAsyncData";

/** A call in the community's list, with what its row counts. */
export type CallSummary = CallRow & {
  workgroups: { name: string } | null;
  call_attendees: Pick<
    CallAttendeeRow,
    "provider" | "status" | "snapshots_seen" | "minutes" | "wallet_address" | "task_id"
  >[];
};

/** The community's calls, newest first (members read them through RLS). */
export function useCalls(communityId: string | null | undefined): AsyncData<CallSummary[]> {
  return useAsyncData(communityId, async () => {
    const { data, error } = await browserClient()
      .from("calls")
      .select(
        `${CALL_COLUMNS}, workgroups!inner(name), call_attendees(provider, status, snapshots_seen, minutes, wallet_address, task_id)`,
      )
      .eq("community_id", communityId)
      .order("starts_at", { ascending: false });
    if (error) throw new Error(error.message);
    return (data ?? []) as unknown as CallSummary[];
  });
}

/** One call with its attendee list and the attendance tasks created from it. */
export type CallDetails = CallRow & {
  workgroups: { name: string; archived_at: string | null } | null;
  call_attendees: CallAttendee[];
  call_tasks: CallTaskLink[];
  /** Voice-channel snapshots taken so far (Discord calls). */
  call_snapshots: Pick<CallSnapshotRow, "id" | "taken_at" | "source">[];
};

export function useCall(callId: string | null | undefined): AsyncData<CallDetails | null> {
  return useAsyncData(callId, async () => {
    const { data, error } = await browserClient()
      .from("calls")
      .select(
        `${CALL_COLUMNS}, workgroups!inner(name, archived_at), call_attendees(${CALL_ATTENDEES_EMBED}), call_tasks(${CALL_TASKS_EMBED}), call_snapshots(id, taken_at, source)`,
      )
      .eq("id", callId)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (data as unknown as CallDetails | null) ?? null;
  });
}

/** The community's connection to a call platform, or null (members read it through RLS). */
export function useCallIntegration(
  communityId: string | null | undefined,
  provider: CallIntegrationRow["provider"],
): AsyncData<CallIntegrationRow | null> {
  return useAsyncData(communityId ? `${communityId}:${provider}` : null, async () => {
    const { data, error } = await browserClient()
      .from("call_integrations")
      .select(CALL_INTEGRATION_COLUMNS)
      .eq("community_id", communityId)
      .eq("provider", provider)
      .maybeSingle();
    if (error) throw new Error(error.message);
    return (data as CallIntegrationRow | null) ?? null;
  });
}

/** A linked meeting with the workgroup its calls are created in. */
export type MeetingLink = CallMeetingLinkRow & { workgroups: { name: string; archived_at: string | null } | null };

/** The community's linked meetings (members read them through RLS). */
export function useMeetingLinks(communityId: string | null | undefined): AsyncData<MeetingLink[]> {
  return useAsyncData(communityId, async () => {
    const { data, error } = await browserClient()
      .from("call_meeting_links")
      .select(`${CALL_MEETING_LINK_COLUMNS}, workgroups!inner(name, archived_at)`)
      .eq("community_id", communityId)
      .order("created_at");
    if (error) throw new Error(error.message);
    return (data ?? []) as unknown as MeetingLink[];
  });
}
