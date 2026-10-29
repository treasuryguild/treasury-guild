"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api/client";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useCallIntegration, useMeetingLinks, type MeetingLink } from "@/hooks/useCalls";
import { useWorkgroups } from "@/hooks/useWorkgroups";
import { Button, Card, ConfirmDialog, ErrorText } from "@/components/ui";
import { MeetingLinkDialog } from "./MeetingLinkDialog";

const PLATFORM_LABEL = { zoom: "Zoom", meet: "Google Meet" } as const;

/**
 * Linked Zoom and Google Meet meetings on Call platforms: a recurring meeting
 * tied to a workgroup, whose calls create themselves when the meeting runs.
 * Host accounts are connected under Integrations.
 */
export function LinkedMeetingsCard({ communityId }: { communityId: string }) {
  const zoom = useCallIntegration(communityId, "zoom");
  const google = useCallIntegration(communityId, "google");
  const platforms = [...(zoom.data ? (["zoom"] as const) : []), ...(google.data ? (["meet"] as const) : [])];
  const links = useMeetingLinks(communityId);
  const workgroups = useWorkgroups(communityId);
  const remove = useAsyncAction("Could not remove the link");
  const [adding, setAdding] = useState(false);
  const [editing, setEditing] = useState<MeetingLink | null>(null);
  const [removing, setRemoving] = useState<MeetingLink | null>(null);

  async function removeNow(link: MeetingLink) {
    const ok = await remove.run(() => apiFetch(`/api/calls/meeting-links/${link.id}`, { method: "DELETE" }));
    if (ok) {
      setRemoving(null);
      links.reload();
    }
  }

  return (
    <Card>
      <h3 className="font-medium">🔁 Linked meetings</h3>
      <p className="mt-1 text-sm text-zinc-400">
        Link a recurring Zoom or Google Meet meeting (or a personal room) to the workgroup that
        rewards it, once. From then on a call creates itself whenever that meeting runs, with the
        link&apos;s title and reward, and you review and reward it whenever you like: a Zoom call
        as the first person joins, a Meet call within about 5 minutes. Meetings you did not link
        stay private: managers find Zoom ones under Detected meetings on the Calls page for a
        day, and Google Meet ones are never read.
      </p>
      <ErrorText error={links.error ?? workgroups.error} className="mt-3" />

      <div className="mt-4 space-y-2">
        {(links.data ?? []).map((link) => (
          <div key={link.id} className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-zinc-800 p-3">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{link.title}</p>
              <p className="mt-0.5 text-xs text-zinc-500">
                {PLATFORM_LABEL[link.provider]} <span className="font-mono">{link.meeting_ref}</span> · {link.workgroups?.name}
                {link.workgroups?.archived_at ? " (archived: paused)" : ""} ·{" "}
                {Object.entries(link.amounts).map(([ticker, amount]) => `${amount} ${ticker}`).join(" + ")}
                {link.min_minutes > 0 ? ` · from ${link.min_minutes} min` : ""}
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="secondary" onClick={() => setEditing(link)}>Edit</Button>
              <Button variant="ghost" onClick={() => setRemoving(link)}>Remove</Button>
            </div>
          </div>
        ))}
      </div>

      <div className="mt-4">
        {platforms.length > 0 ? (
          <Button variant="secondary" disabled={!workgroups.data?.length} onClick={() => setAdding(true)}>Link a meeting</Button>
        ) : (
          !zoom.loading && !google.loading && (
            <p className="text-xs text-zinc-500">Connect a Zoom or Google account on this page first.</p>
          )
        )}
      </div>

      {(adding || editing) && (
        <MeetingLinkDialog open communityId={communityId} link={editing ?? undefined} platforms={platforms}
          workgroups={workgroups.data ?? []}
          onClose={() => { setAdding(false); setEditing(null); }}
          onSaved={() => { setAdding(false); setEditing(null); links.reload(); }} />
      )}
      <ConfirmDialog open={!!removing} busy={remove.busy} error={remove.error}
        title="Remove this linked meeting?" confirmLabel="Remove"
        onCancel={() => setRemoving(null)} onConfirm={() => removing && void removeNow(removing)}>
        New calls stop being created for meeting {removing?.meeting_ref}. Calls it already created stay as they are.
      </ConfirmDialog>
    </Card>
  );
}
