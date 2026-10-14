"use client";

import { apiFetch } from "@/lib/api/client";
import type { DetectedMeetingsResponse } from "@/lib/api/types";
import type { DetectedMeeting } from "@/lib/calls/zoomSessions";
import { formatDate, plural } from "@/lib/format";
import { useAsyncData } from "@/hooks/useAsyncData";
import { Badge, Button } from "@/components/ui";

/**
 * Meetings of the connected Zoom account that people joined in the last day
 * and that are not a call yet. Managers only; listing one as a call brings in
 * everyone who was there.
 */
export function DetectedMeetings({
  workgroupId,
  onCreate,
}: {
  /** Any workgroup the viewer manages: it proves they may create calls. */
  workgroupId: string;
  onCreate: (meeting: DetectedMeeting) => void;
}) {
  const detected = useAsyncData(workgroupId, () =>
    apiFetch<DetectedMeetingsResponse>("/api/calls/detected", { query: { workgroupId } }),
  );
  const meetings = detected.data?.meetings ?? [];
  if (meetings.length === 0) return null;

  return (
    <section className="mb-6">
      <h2 className="text-sm font-medium">Detected meetings</h2>
      <p className="mb-3 mt-0.5 max-w-3xl text-xs text-zinc-500">
        Zoom meetings of the connected account that are not a call yet. Only managers see them, and
        they are forgotten after a day. Creating the call brings in everyone who joined.
      </p>
      <div className="space-y-2">
        {meetings.map((m) => (
          <div key={`${m.meetingRef}:${m.instance ?? ""}`}
            className="glass-panel flex flex-col items-start justify-between gap-3 rounded-2xl p-4 sm:flex-row sm:items-center">
            <div className="min-w-0">
              <p className="truncate text-sm font-medium">{m.topic ?? `Meeting ${m.meetingRef}`}</p>
              <p className="mt-0.5 text-xs text-zinc-500">
                {formatDate(m.startedAt, "datetime")} · <span className="font-mono">{m.meetingRef}</span> ·{" "}
                {plural(m.participants, "participant")}
              </p>
            </div>
            <div className="flex items-center gap-2">
              {!m.endedAt && <Badge tone="blue">Running</Badge>}
              <Button variant="secondary" onClick={() => onCreate(m)}>Create call</Button>
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}
