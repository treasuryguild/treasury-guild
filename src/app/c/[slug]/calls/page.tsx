"use client";

import { use, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { countStandings } from "@/lib/calls/qualify";
import { CALL_PROVIDER_LABELS, CallProvider } from "@/lib/constants";
import { formatDate, plural } from "@/lib/format";
import { routes } from "@/lib/routes";
import { useCalls } from "@/hooks/useCalls";
import { useCommunityGate } from "@/hooks/useCommunityGate";
import { useMyTreasuryRoles } from "@/hooks/useMyTreasuryRoles";
import { useWorkgroups } from "@/hooks/useWorkgroups";
import { CallFormDialog, type CallPrefill } from "@/components/calls/CallFormDialog";
import { DetectedMeetings } from "@/components/calls/DetectedMeetings";
import { Badge, Button, CallStateBadge, EmptyState, ErrorText, PageTitle } from "@/components/ui";
import { managesWorkgroup } from "@/lib/roles";

export default function CallsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const router = useRouter();
  const { community, isAdmin, blocked } = useCommunityGate(slug);
  const calls = useCalls(community?.id);
  const workgroups = useWorkgroups(community?.id);
  const roles = useMyTreasuryRoles(community?.id);
  const [creating, setCreating] = useState(false);
  const [prefill, setPrefill] = useState<CallPrefill | null>(null);

  // Admins create calls anywhere, leads in the workgroups they lead.
  const manageable = useMemo(
    () => (workgroups.data ?? []).filter((w) => managesWorkgroup({ isAdmin, ledWorkgroupIds: roles.ledWorkgroupIds }, w.id)),
    [workgroups.data, isAdmin, roles.ledWorkgroupIds],
  );

  if (blocked) return blocked;

  return (
    <div>
      <PageTitle action={manageable.length > 0 && <Button onClick={() => setCreating(true)}>New call</Button>}>
        Calls
      </PageTitle>
      <p className="-mt-3 mb-6 max-w-3xl text-sm text-zinc-400">
        Reward people for attending community calls on Discord, Zoom, Meet or anywhere else.
        Attendees check in with their wallet; the list becomes a payable task on Payday.
      </p>
      <ErrorText error={calls.error ?? workgroups.error} className="mb-3" />

      {manageable[0] && (
        <DetectedMeetings workgroupId={manageable[0].id} onCreate={(m) => setPrefill({
          provider: CallProvider.Zoom,
          title: m.topic ?? "",
          externalRef: m.meetingRef,
          startsAt: m.startedAt,
          // Still running: an hour from the start, to be corrected once it ends.
          endsAt: m.endedAt ?? new Date(Date.parse(m.startedAt) + 60 * 60000).toISOString(),
        })} />
      )}

      <div className="space-y-3">
        {(calls.data ?? []).map((call) => {
          const counts = countStandings(call, call.call_attendees);
          return (
            <Link key={call.id} href={routes.call(slug, call.id)}
              className="glass-panel flex flex-col items-start justify-between gap-3 rounded-2xl p-4 hover:border-indigo-600 sm:flex-row sm:items-center">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">{call.title}</p>
                <p className="mt-0.5 text-xs text-zinc-500">
                  {formatDate(call.starts_at, "datetime")} · {CALL_PROVIDER_LABELS[call.provider]} · {call.workgroups?.name}
                </p>
              </div>
              <div className="flex flex-wrap items-center gap-2 text-xs text-zinc-400">
                <span>{plural(call.call_attendees.length, "attendee")}</span>
                {call.meeting_link_id && <Badge>Linked meeting</Badge>}
                {counts.unlinked > 0 && <Badge tone="yellow">{counts.unlinked} no wallet</Badge>}
                {counts.ready > 0 && <Badge tone="blue">{counts.ready} ready</Badge>}
                {Object.entries(call.amounts).map(([ticker, amount]) => (
                  <span key={ticker} className="text-sm font-medium text-zinc-200">{amount} {ticker}</span>
                ))}
                <CallStateBadge state={call.state} />
              </div>
            </Link>
          );
        })}
        {calls.data?.length === 0 && (
          <EmptyState>
            No calls yet.{manageable.length > 0 ? " Create one before the call starts, then share its check-in code." : ""}
          </EmptyState>
        )}
      </div>

      {(creating || prefill) && (
        <CallFormDialog open slug={slug} communityId={community!.id} workgroups={manageable} prefill={prefill ?? undefined}
          onClose={() => { setCreating(false); setPrefill(null); }}
          onSaved={(call) => router.push(routes.call(slug, call.id))} />
      )}
    </div>
  );
}
