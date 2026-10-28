"use client";

import { useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api/client";
import type { CreateCallBody, PatchCallBody } from "@/lib/api/schemas";
import type { CallResponse, DiscordChannelsResponse } from "@/lib/api/types";
import { rewardFromRows, rewardRows, type AmountRow } from "@/lib/boardTypes";
import { parseMeetingRef, ZOOM_MEETING_ID_ERROR } from "@/lib/calls/meetingRef";
import { CALL_PROVIDER_LABELS, CallProvider } from "@/lib/constants";
import type { CallRow } from "@/lib/db/types";
import { routes } from "@/lib/routes";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useAsyncData } from "@/hooks/useAsyncData";
import { useCallIntegration } from "@/hooks/useCalls";
import type { WorkgroupSummary } from "@/hooks/useWorkgroups";
import { Button, ErrorText, Field, Input, Modal, Select } from "@/components/ui";
import { RewardRowsField } from "./RewardRowsField";

/** Platforms captured from a meeting of a connected host account, and how the form asks for it. */
const HOSTED: Partial<Record<CallProvider, {
  integration: "zoom" | "google";
  account: string;
  refLabel: string;
  refHint: string;
  placeholder: string;
  invalid: string;
  normalize: (input: string) => string | null;
}>> = {
  [CallProvider.Zoom]: {
    integration: "zoom",
    account: "the Zoom account that hosts your calls",
    refLabel: "Meeting ID",
    refHint: "A meeting hosted by the connected Zoom account.",
    placeholder: "812 3456 7890",
    invalid: ZOOM_MEETING_ID_ERROR,
    normalize: (input) => parseMeetingRef("zoom", input),
  },
  [CallProvider.Meet]: {
    integration: "google",
    account: "the Google account that organises your meetings",
    refLabel: "Meet link or code",
    refHint: "A meeting created by the connected Google account.",
    placeholder: "meet.google.com/abc-mnop-xyz",
    invalid: "Paste the Meet link, or its code (abc-mnop-xyz)",
    normalize: (input) => parseMeetingRef("meet", input),
  },
};

/** ISO timestamp -> the local value a datetime-local input shows. */
function toLocalInput(iso: string): string {
  const d = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function defaultStart(): string {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  return toLocalInput(d.toISOString());
}

/** A detected meeting being listed as a call: what is already known about it. */
export interface CallPrefill {
  provider: CallProvider;
  title: string;
  externalRef: string;
  /** ISO timestamps of when the meeting really ran. */
  startsAt: string;
  endsAt: string;
}

/**
 * Create a call, or edit one. The workgroup decides who may manage the call
 * and which budget and wallet pay the reward; it is fixed once created. The
 * reward locks when the first attendance task exists (`rewardLocked`). A
 * Discord call can name the voice channel it is captured from, once the
 * community connected its server.
 */
export function CallFormDialog({
  open,
  slug,
  communityId,
  call,
  prefill,
  workgroups,
  rewardLocked = false,
  onClose,
  onSaved,
}: {
  open: boolean;
  slug: string;
  communityId: string;
  /** Set when editing. */
  call?: CallRow;
  /** Set when creating from a detected meeting. */
  prefill?: CallPrefill;
  /** The workgroups the viewer can create calls in. */
  workgroups: WorkgroupSummary[];
  rewardLocked?: boolean;
  onClose: () => void;
  onSaved: (call: CallRow) => void;
}) {
  const [title, setTitle] = useState(call?.title ?? prefill?.title ?? "");
  const [provider, setProvider] = useState<CallProvider>(call?.provider ?? prefill?.provider ?? CallProvider.Discord);
  const [workgroupId, setWorkgroupId] = useState(call?.workgroup_id ?? workgroups[0]?.id ?? "");
  const [startsAt, setStartsAt] = useState(() => {
    const known = call?.starts_at ?? prefill?.startsAt;
    return known ? toLocalInput(known) : defaultStart();
  });
  const [minutes, setMinutes] = useState(() => {
    const span = call ? [call.starts_at, call.ends_at] as const : prefill ? [prefill.startsAt, prefill.endsAt] as const : null;
    // Whole minutes of the datetime-local start, rounded up so the real end stays inside.
    return span ? String(Math.max(1, Math.ceil((Date.parse(span[1]) - Date.parse(toLocalInput(span[0]))) / 60000))) : "60";
  });
  const [rows, setRows] = useState<AmountRow[]>(() => rewardRows(call?.amounts));
  const [channelId, setChannelId] = useState(call?.external_ref ?? prefill?.externalRef ?? "");
  const [minSnapshots, setMinSnapshots] = useState(String(call?.min_snapshots ?? 1));
  const [minMinutes, setMinMinutes] = useState(String(call?.min_minutes ?? 0));
  const action = useAsyncAction();

  const isDiscord = (call?.provider ?? provider) === CallProvider.Discord;
  const channelsFor = call?.workgroup_id ?? workgroupId;
  const channels = useAsyncData(isDiscord && channelsFor ? channelsFor : null, () =>
    apiFetch<DiscordChannelsResponse>("/api/calls/discord-channels", { query: { workgroupId: channelsFor } }),
  );
  const canCapture = isDiscord && !!channels.data?.connected;
  // Zoom and Meet are captured the same way: a meeting reference plus minimum minutes,
  // once the account that hosts the community's meetings is connected.
  const hosted = HOSTED[call?.provider ?? provider];
  const hostAccount = useCallIntegration(hosted ? communityId : null, hosted?.integration ?? "zoom");
  const canCaptureHosted = !!hosted && !!hostAccount.data;

  async function save() {
    const saved = await action.run(async () => {
      const amounts = rewardFromRows(rows);
      const start = new Date(startsAt);
      const length = Number(minutes);
      if (Number.isNaN(start.getTime())) throw new Error("Choose when the call starts");
      if (!Number.isInteger(length) || length < 1) throw new Error("Length must be a whole number of minutes");
      const snapshots = Number(minSnapshots);
      if (canCapture && (!Number.isInteger(snapshots) || snapshots < 0)) {
        throw new Error("Minimum snapshots must be a whole number");
      }
      const presentFor = Number(minMinutes);
      if (canCaptureHosted && (!Number.isInteger(presentFor) || presentFor < 0)) {
        throw new Error("Minimum minutes must be a whole number");
      }
      let meetingRef: string | null = null;
      if (canCaptureHosted && hosted && channelId.trim()) {
        meetingRef = hosted.normalize(channelId);
        if (!meetingRef) throw new Error(hosted.invalid);
      }
      // Untouched unless the platform is connected: a reference is never cleared by accident.
      const capture = canCapture
        ? { externalRef: channelId || null, minSnapshots: snapshots }
        : canCaptureHosted
          ? { externalRef: meetingRef, minMinutes: presentFor }
          : {};
      const times = {
        startsAt: start.toISOString(),
        endsAt: new Date(start.getTime() + length * 60000).toISOString(),
      };
      if (call) {
        const body: PatchCallBody = { title, ...times, ...capture, ...(rewardLocked ? {} : { amounts }) };
        return apiFetch<CallResponse>(`/api/calls/${call.id}`, { method: "PATCH", body });
      }
      if (!workgroupId) throw new Error("Choose a workgroup");
      const body: CreateCallBody = { workgroupId, provider, title, ...times, ...capture, amounts };
      return apiFetch<CallResponse>("/api/calls", { body });
    });
    if (saved) onSaved(saved.call);
  }

  return (
    <Modal open={open} onClose={onClose} busy={action.busy} title={call ? "Edit call" : "New call"} className="w-full">
      <div className="space-y-4">
        <Field label="Title">
          <Input value={title} maxLength={120} placeholder="Weekly town hall" onChange={(e) => setTitle(e.target.value)} />
        </Field>
        {!call && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Platform">
              <Select value={provider} onChange={(e) => {
                setProvider(e.target.value as CallProvider);
                // A voice channel id means nothing to Zoom, and the other way round.
                setChannelId("");
              }}>
                {Object.values(CallProvider).map((p) => (
                  <option key={p} value={p}>{CALL_PROVIDER_LABELS[p]}</option>
                ))}
              </Select>
            </Field>
            <Field label="Workgroup" hint="Its budget and wallet pay the reward.">
              <Select value={workgroupId} onChange={(e) => setWorkgroupId(e.target.value)}>
                {workgroups.map((w) => (
                  <option key={w.id} value={w.id}>{w.name}</option>
                ))}
              </Select>
            </Field>
          </div>
        )}
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Starts">
            <Input type="datetime-local" value={startsAt} onChange={(e) => setStartsAt(e.target.value)} />
          </Field>
          <Field label="Length (minutes)" hint="Check-in closes when the call ends.">
            <Input inputMode="numeric" value={minutes} onChange={(e) => setMinutes(e.target.value)} />
          </Field>
        </div>
        {isDiscord && (canCapture ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="Voice channel" hint={`Captured from ${channels.data?.serverName ?? "your Discord server"} while the call runs.`}>
              <Select value={channelId} onChange={(e) => setChannelId(e.target.value)}>
                <option value="">Not captured</option>
                {channels.data?.channels.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </Select>
            </Field>
            <Field label="Minimum snapshots" hint="Taken every 5 minutes; seen in this many to be rewarded.">
              <Input inputMode="numeric" value={minSnapshots} onChange={(e) => setMinSnapshots(e.target.value)} />
            </Field>
          </div>
        ) : (
          !channels.loading && (
            <p className="text-xs text-zinc-500">
              {channels.error ?? "To capture who is in the voice channel automatically, an admin connects the Discord server in"}{" "}
              {!channels.error && (
                <Link href={routes.integrations(slug)} className="text-indigo-400 hover:underline">Integrations</Link>
              )}
              {!channels.error && ". Check-in works without it."}
            </p>
          )
        ))}
        {hosted && (canCaptureHosted ? (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={hosted.refLabel} hint={`${hosted.refHint} Leave empty to rely on check-in.`}>
              <Input value={channelId} placeholder={hosted.placeholder} spellCheck={false}
                onChange={(e) => setChannelId(e.target.value)} />
            </Field>
            <Field label="Minimum minutes" hint="Present at least this long, between start and end, to be rewarded.">
              <Input inputMode="numeric" value={minMinutes} onChange={(e) => setMinMinutes(e.target.value)} />
            </Field>
          </div>
        ) : (
          !hostAccount.loading && (
            <p className="text-xs text-zinc-500">
              To capture who attends automatically, an admin connects {hosted.account} in{" "}
              <Link href={routes.callSettings(slug)} className="text-indigo-400 hover:underline">Call platforms</Link>.
              Check-in and pasted lists work without it.
            </p>
          )
        ))}
        <RewardRowsField rows={rows} onChange={setRows} locked={rewardLocked} />
      </div>
      <ErrorText error={action.error} className="mt-3" />
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose} disabled={action.busy}>Cancel</Button>
        <Button onClick={() => void save()} loading={action.busy}>
          {action.busy ? "Saving…" : call ? "Save" : "Create call"}
        </Button>
      </div>
    </Modal>
  );
}
