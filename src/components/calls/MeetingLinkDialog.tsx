"use client";

import { useMemo, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { CreateMeetingLinkBody, PatchMeetingLinkBody } from "@/lib/api/schemas";
import type { MeetingLinkResponse } from "@/lib/api/types";
import { rewardFromRows, rewardRows, type AmountRow } from "@/lib/boardTypes";
import { MEET_CODE_ERROR, parseMeetingRef, ZOOM_MEETING_ID_ERROR } from "@/lib/calls/meetingRef";
import type { CallMeetingLinkRow } from "@/lib/db/types";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useTreasuryTokenTickers } from "@/hooks/useTreasuryTokenTickers";
import type { WorkgroupSummary } from "@/hooks/useWorkgroups";
import { Button, ErrorText, Field, Input, Modal, Select } from "@/components/ui";
import { RewardRowsField } from "./RewardRowsField";

type Platform = CallMeetingLinkRow["provider"];

const PLATFORM = {
  zoom: {
    label: "Zoom",
    field: "Meeting ID",
    hint: "A recurring meeting or personal room of the connected Zoom account.",
    placeholder: "812 3456 7890",
  },
  meet: {
    label: "Google Meet",
    field: "Meet code or link",
    hint: "A meeting the connected Google account organises.",
    placeholder: "abc-mnop-xyz",
  },
} as const;

/** What the manager typed -> the stored meeting reference, or the reason it is not one. */
function meetingRefOf(platform: Platform, input: string): string {
  const ref = parseMeetingRef(platform, input);
  if (!ref) throw new Error(platform === "meet" ? MEET_CODE_ERROR : ZOOM_MEETING_ID_ERROR);
  return ref;
}

/**
 * Link a recurring Zoom or Google Meet meeting to a workgroup, or edit the
 * link. The meeting and the workgroup are fixed once linked (remove the link
 * to change them); what its future calls carry (title, reward, threshold,
 * length) can change.
 */
export function MeetingLinkDialog({
  open,
  communityId,
  link,
  platforms,
  workgroups,
  onClose,
  onSaved,
}: {
  open: boolean;
  communityId: string;
  /** Set when editing. */
  link?: CallMeetingLinkRow;
  /** The platforms with a connected host account: what a new link can be of. */
  platforms: readonly Platform[];
  workgroups: WorkgroupSummary[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [platform, setPlatform] = useState<Platform>(link?.provider ?? platforms[0] ?? "zoom");
  const [meetingId, setMeetingId] = useState(link?.meeting_ref ?? "");
  const [workgroupId, setWorkgroupId] = useState(link?.workgroup_id ?? workgroups[0]?.id ?? "");
  const [title, setTitle] = useState(link?.title ?? "");
  const [rows, setRows] = useState<AmountRow[]>(() => rewardRows(link?.amounts));
  const [minMinutes, setMinMinutes] = useState(String(link?.min_minutes ?? 0));
  const [duration, setDuration] = useState(String(link?.duration_minutes ?? 60));
  const action = useAsyncAction();

  const treasuryId = workgroups.find((w) => w.id === workgroupId)?.treasury_id ?? null;
  const walletTickers = useTreasuryTokenTickers(communityId, treasuryId, open);
  const tickers = useMemo(
    () => ["ADA", ...walletTickers.filter((t) => t.toLowerCase() !== "ada")],
    [walletTickers],
  );

  async function save() {
    const saved = await action.run(async () => {
      const amounts = rewardFromRows(rows);
      const presentFor = Number(minMinutes);
      if (!Number.isInteger(presentFor) || presentFor < 0) throw new Error("Minimum minutes must be a whole number");
      const length = Number(duration);
      if (!Number.isInteger(length) || length < 1) throw new Error("Usual length must be a whole number of minutes");
      const fields = { title, amounts, minMinutes: presentFor, durationMinutes: length };
      if (link) {
        const body: PatchMeetingLinkBody = fields;
        return apiFetch<MeetingLinkResponse>(`/api/calls/meeting-links/${link.id}`, { method: "PATCH", body });
      }
      const meetingRef = meetingRefOf(platform, meetingId);
      if (!workgroupId) throw new Error("Choose a workgroup");
      const body: CreateMeetingLinkBody = { workgroupId, provider: platform, meetingRef, ...fields };
      return apiFetch<MeetingLinkResponse>("/api/calls/meeting-links", { body });
    });
    if (saved) onSaved();
  }

  return (
    <Modal open={open} onClose={onClose} busy={action.busy} title={link ? "Edit linked meeting" : "Link a meeting"} className="w-full">
      <div className="space-y-4">
        {!link && platforms.length > 1 && (
          <Field label="Platform">
            <Select value={platform} onChange={(e) => setPlatform(e.target.value as Platform)}>
              {platforms.map((p) => (
                <option key={p} value={p}>{PLATFORM[p].label}</option>
              ))}
            </Select>
          </Field>
        )}
        {!link && (
          <div className="grid gap-4 sm:grid-cols-2">
            <Field label={PLATFORM[platform].field} hint={PLATFORM[platform].hint}>
              <Input value={meetingId} placeholder={PLATFORM[platform].placeholder} spellCheck={false}
                onChange={(e) => setMeetingId(e.target.value)} />
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
        <Field label="Call title" hint="Each call it creates carries this title.">
          <Input value={title} maxLength={120} placeholder="Weekly town hall" onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Minimum minutes" hint="Present at least this long to be rewarded.">
            <Input inputMode="numeric" value={minMinutes} onChange={(e) => setMinMinutes(e.target.value)} />
          </Field>
          <Field label="Usual length (minutes)" hint="Until the meeting itself says when it really ended.">
            <Input inputMode="numeric" value={duration} onChange={(e) => setDuration(e.target.value)} />
          </Field>
        </div>
        <RewardRowsField rows={rows} onChange={setRows} tickers={tickers} />
      </div>
      <ErrorText error={action.error} className="mt-3" />
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose} disabled={action.busy}>Cancel</Button>
        <Button onClick={() => void save()} loading={action.busy}>
          {action.busy ? "Saving…" : link ? "Save" : "Link meeting"}
        </Button>
      </div>
    </Modal>
  );
}
