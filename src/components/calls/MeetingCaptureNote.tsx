import { CallProvider } from "@/lib/constants";
import type { CallRow } from "@/lib/db/types";
import { formatDate } from "@/lib/format";
import { Card, SectionTitle } from "@/components/ui";

const COPY = {
  [CallProvider.Zoom]: {
    title: "Zoom capture",
    ref: "Meeting",
    live: "People appear on the list as they join",
    pending: "About 10 minutes after the call ends, Zoom's participant report is read to make the minutes final.",
    final: "Zoom's participant report was read",
    none: "No meeting ID, so this call is not captured from Zoom.",
  },
  [CallProvider.Meet]: {
    title: "Google Meet capture",
    ref: "Meeting",
    live: "While the call runs the list is refreshed every 5 minutes",
    pending: "The final times are read about 10 minutes after the call ends.",
    final: "Meet's final times were read",
    none: "No Meet code, so this call is not captured from Google Meet.",
  },
} as const;

/** How a Zoom or Meet call's attendance arrives, and where it stands. */
export function MeetingCaptureNote({
  call,
}: {
  call: Pick<CallRow, "provider" | "external_ref" | "min_minutes" | "captured_at" | "meeting_link_id">;
}) {
  if (call.provider !== CallProvider.Zoom && call.provider !== CallProvider.Meet) return null;
  const copy = COPY[call.provider];
  return (
    <Card>
      <SectionTitle>{copy.title}</SectionTitle>
      {call.external_ref ? (
        <p className="text-sm text-zinc-400">
          {copy.ref} <span className="font-mono text-zinc-300">{call.external_ref}</span>. {copy.live}; minutes
          count between the call&apos;s start and end, and an attendee is rewarded from {call.min_minutes} minute
          {call.min_minutes === 1 ? "" : "s"}.{" "}
          {call.captured_at
            ? `${copy.final} ${formatDate(call.captured_at, "datetime")}: the minutes are final.`
            : copy.pending}
          {call.meeting_link_id &&
            " This call created itself from a linked meeting: its start and end follow the meeting, and you can still edit them."}
        </p>
      ) : (
        <p className="text-sm text-zinc-400">
          {copy.none} Edit the call to add one, or use check-in and a pasted participant list.
        </p>
      )}
    </Card>
  );
}
