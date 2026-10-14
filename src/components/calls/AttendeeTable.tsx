"use client";

import { Trash2 } from "lucide-react";
import { contributorLabel } from "@/lib/assignees";
import { attendeeStanding, type AttendeeStanding } from "@/lib/calls/qualify";
import { AttendeeSource, AttendeeStatus } from "@/lib/constants";
import type { CallAttendee, CallRow } from "@/lib/db/types";
import { plural } from "@/lib/format";
import { Badge, Button, EmptyState, InsetRow, type BadgeTone } from "@/components/ui";

const SOURCE_LABELS: Record<AttendeeSource, string> = {
  [AttendeeSource.Discord]: "Discord",
  [AttendeeSource.Zoom]: "Zoom",
  [AttendeeSource.Meet]: "Meet",
  [AttendeeSource.Checkin]: "check-in",
  [AttendeeSource.Manual]: "added",
};

const STANDING: Record<AttendeeStanding, { tone: BadgeTone; label: string }> = {
  rewarded: { tone: "green", label: "On a task" },
  ready: { tone: "blue", label: "Ready" },
  unlinked: { tone: "yellow", label: "No wallet" },
  "below-threshold": { tone: "default", label: "Below threshold" },
  excluded: { tone: "red", label: "Excluded" },
};

/** What was captured of a platform attendee; nothing for check-ins and manual rows. */
function presence(a: CallAttendee): string | null {
  if (a.provider === AttendeeSource.Discord) {
    return `${plural(a.snapshots_seen, "snapshot")}`;
  }
  if (a.provider === AttendeeSource.Zoom || a.provider === AttendeeSource.Meet) return `${a.minutes} min`;
  return null;
}

/**
 * A call's attendee list. Managers link wallets, override the threshold
 * (confirm / exclude) and remove rows, until the attendee is on an attendance
 * task: from then on the task is the record.
 */
export function AttendeeTable({
  call,
  attendees,
  taskNumbers,
  canManage,
  busy,
  onLink,
  onStatus,
  onRemove,
}: {
  call: Pick<CallRow, "min_snapshots" | "min_minutes">;
  attendees: CallAttendee[];
  /** task id -> task number, for attendees already on a task. */
  taskNumbers: ReadonlyMap<string, number>;
  canManage: boolean;
  busy: boolean;
  onLink: (attendee: CallAttendee) => void;
  onStatus: (attendee: CallAttendee, status: AttendeeStatus) => void;
  onRemove: (attendee: CallAttendee) => void;
}) {
  if (attendees.length === 0) {
    return (
      <EmptyState>
        Nobody on the list yet. Share the check-in code during the call, or paste the
        participant list afterwards.
      </EmptyState>
    );
  }
  return (
    <div className="space-y-2">
      {attendees.map((a) => {
        const standing = attendeeStanding(call, a);
        const badge = STANDING[standing];
        const taskNumber = a.task_id ? taskNumbers.get(a.task_id) : undefined;
        const seen = presence(a);
        return (
          <InsetRow key={a.id}>
            <div className="min-w-0">
              <p className="truncate text-sm">
                {a.display_name} <span className="text-xs text-zinc-500">· {SOURCE_LABELS[a.provider]}</span>
                {seen && <span className="text-xs text-zinc-500"> · {seen}</span>}
              </p>
              <p className="truncate text-xs text-zinc-500">
                {a.wallet_address
                  ? contributorLabel({
                    wallet: a.wallet_address,
                    handle: a.contributors?.handle ?? null,
                    githubUsername: a.contributors?.github_username ?? null,
                  })
                  : "not linked to a wallet"}
              </p>
            </div>
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={badge.tone}>
                {standing === "rewarded" && taskNumber !== undefined ? `Task #${taskNumber}` : badge.label}
              </Badge>
              {canManage && !a.task_id && (
                <>
                  {a.provider !== AttendeeSource.Checkin && (
                    <Button variant={standing === "unlinked" ? "primary" : "secondary"} disabled={busy}
                      aria-label={`Link a wallet to ${a.display_name}`} onClick={() => onLink(a)}>
                      {a.wallet_address ? "Change wallet" : "Link wallet"}
                    </Button>
                  )}
                  {standing === "below-threshold" && (
                    <Button variant="secondary" disabled={busy} onClick={() => onStatus(a, AttendeeStatus.Confirmed)}>
                      Confirm
                    </Button>
                  )}
                  {a.status === AttendeeStatus.Excluded ? (
                    <Button variant="secondary" disabled={busy} onClick={() => onStatus(a, AttendeeStatus.Auto)}>
                      Include
                    </Button>
                  ) : (
                    <Button variant="ghost" disabled={busy} onClick={() => onStatus(a, AttendeeStatus.Excluded)}>
                      Exclude
                    </Button>
                  )}
                  <Button variant="ghost" className="!min-h-8 !p-1.5" disabled={busy}
                    aria-label={`Remove ${a.display_name}`} onClick={() => onRemove(a)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                </>
              )}
            </div>
          </InsetRow>
        );
      })}
    </div>
  );
}
