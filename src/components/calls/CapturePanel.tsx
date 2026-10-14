"use client";

import { apiFetch } from "@/lib/api/client";
import type { CaptureCallResponse } from "@/lib/api/types";
import { checkinWindow } from "@/lib/calls/checkinCode";
import type { CallRow, CallSnapshotRow } from "@/lib/db/types";
import { formatDate, plural } from "@/lib/format";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useNow } from "@/hooks/useNow";
import { Button, Card, ErrorText, SectionTitle } from "@/components/ui";

/**
 * Voice-channel capture of a Discord call: how many snapshots exist, and a
 * button to take one now. Snapshots are also taken automatically every few
 * minutes while the call runs; an attendee counts once they were seen in
 * `min_snapshots` of them.
 */
export function CapturePanel({
  call,
  snapshots,
  canManage,
  onCaptured,
}: {
  call: Pick<CallRow, "id" | "external_ref" | "min_snapshots" | "starts_at" | "ends_at">;
  snapshots: Pick<CallSnapshotRow, "id" | "taken_at">[];
  canManage: boolean;
  onCaptured: (result: CaptureCallResponse) => void;
}) {
  const action = useAsyncAction("Could not take a snapshot");
  const running = checkinWindow(call, useNow()) === "open";
  const last = snapshots.reduce<string | null>((max, s) => (!max || s.taken_at > max ? s.taken_at : max), null);

  async function capture() {
    const result = await action.run(() =>
      apiFetch<CaptureCallResponse>(`/api/calls/${call.id}/capture`, { method: "POST" }),
    );
    if (result) onCaptured(result);
  }

  return (
    <Card>
      <SectionTitle>Voice capture</SectionTitle>
      {call.external_ref ? (
        <>
          <p className="text-sm text-zinc-400">
            {snapshots.length === 0
              ? "No snapshots yet."
              : `${plural(snapshots.length, "snapshot")}, last ${formatDate(last!, "datetime")}.`}{" "}
            While the call runs, a snapshot of its voice channel is taken every few minutes. An
            attendee is rewarded once seen in {plural(call.min_snapshots, "snapshot")}.
          </p>
          {canManage && (
            <Button className="mt-4" variant="secondary" disabled={!running} loading={action.busy}
              onClick={() => void capture()}>
              {action.busy ? "Reading the channel…" : "Capture now"}
            </Button>
          )}
          {canManage && !running && (
            <p className="mt-2 text-xs text-zinc-500">Snapshots are taken from 15 minutes before the start until the call ends.</p>
          )}
        </>
      ) : (
        <p className="text-sm text-zinc-400">
          No voice channel chosen, so this call is not captured. {canManage ? "Edit the call to choose one." : ""}
        </p>
      )}
      <ErrorText error={action.error} className="mt-3" />
    </Card>
  );
}
