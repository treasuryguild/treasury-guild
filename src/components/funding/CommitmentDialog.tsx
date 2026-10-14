"use client";

// Add or edit what a funding source committed. A one-off has a total and an
// optional expected month; a recurring commitment an amount per month or
// quarter between two months; a schedule its own amount per period, set in
// the schedule editor once it exists.
import { useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { FundingCommitmentBody } from "@/lib/api/schemas";
import type { FundingCreatedResponse, OkResponse } from "@/lib/api/types";
import type { FundingCommitmentKind, FundingCommitmentRow } from "@/lib/db/types";
import type { FundingTokenOption } from "@/lib/funding/display";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { Button, ErrorText, Field, Input, Modal, Select, Textarea } from "@/components/ui";
import { amountRowsFrom, TokenAmountRows, type AmountRow } from "./TokenAmountRows";

const KIND_HINTS: Record<FundingCommitmentKind, string> = {
  one_off: "One total, for example an approved Catalyst proposal.",
  recurring: "The same amount every month or quarter, for example a fixed monthly release.",
  schedule: "A different amount each period, for example a release plan that shrinks every month. Load it from a CSV next.",
};

export function CommitmentDialog({ sourceId, commitment, initialKind, options, onClose, onSaved }: {
  sourceId: string;
  commitment?: FundingCommitmentRow;
  /** The kind a new commitment starts as (Import CSV opens it as a schedule). */
  initialKind?: FundingCommitmentKind;
  options: readonly FundingTokenOption[];
  onClose: () => void;
  /** With the new commitment's id when one was added. */
  onSaved: (createdId: string | null, kind: FundingCommitmentKind) => void;
}) {
  const [name, setName] = useState(commitment?.name ?? "");
  const [kind, setKind] = useState<FundingCommitmentKind>(commitment?.kind ?? initialKind ?? "one_off");
  const [cadence, setCadence] = useState<"monthly" | "quarterly">(commitment?.cadence ?? "monthly");
  const [startsOn, setStartsOn] = useState(commitment?.starts_on?.slice(0, 7) ?? "");
  const [endsOn, setEndsOn] = useState(commitment?.ends_on?.slice(0, 7) ?? "");
  const [url, setUrl] = useState(commitment?.url ?? "");
  const [note, setNote] = useState(commitment?.note ?? "");
  const [rows, setRows] = useState<AmountRow[]>(
    commitment?.amounts.length ? amountRowsFrom(commitment.amounts) : [{ unit: options[0]?.unit ?? "lovelace", amount: "" }],
  );
  const save = useAsyncAction("Failed to save the commitment");
  const editing = !!commitment;

  async function submit() {
    const amounts = kind === "schedule" ? [] : rows.filter((r) => r.amount !== "");
    const common = { name: name.trim(), url: url.trim() || null, note: note.trim() || null };
    let createdId: string | null = null;
    const result = await save.run(async () => {
      if (editing) {
        return apiFetch<OkResponse>(`/api/funding/commitments/${commitment.id}`, {
          method: "PATCH",
          body: {
            ...common,
            ...(kind !== "schedule" && { startsOn: startsOn || null, amounts }),
            ...(kind === "recurring" && { endsOn: endsOn || null }),
          },
        });
      }
      const body: FundingCommitmentBody = {
        sourceId, ...common, kind,
        cadence: kind === "one_off" ? null : cadence,
        startsOn: kind === "schedule" ? null : startsOn || null,
        endsOn: kind === "recurring" ? endsOn || null : null,
        amounts,
      };
      const created = await apiFetch<FundingCreatedResponse>("/api/funding/commitments", { body });
      createdId = created.id;
      return created;
    });
    if (result) onSaved(createdId, kind);
  }

  const needsAmounts = kind !== "schedule";
  const ready = name.trim() !== "" && (kind !== "recurring" || startsOn !== "") &&
    (!needsAmounts || rows.some((r) => r.amount !== ""));

  return (
    <Modal open onClose={onClose} busy={save.busy} scroll title={editing ? "Edit commitment" : "Add a commitment"}>
      <div className="space-y-4">
        <Field label="Name" hint="For example the proposal's title, or “Monthly allocation 2026”.">
          <Input aria-label="Commitment name" value={name} maxLength={120} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Kind" hint={KIND_HINTS[kind]}>
          <Select aria-label="Commitment kind" value={kind} disabled={editing}
            onChange={(e) => setKind(e.target.value as FundingCommitmentKind)}>
            <option value="one_off">One-off amount</option>
            <option value="recurring">Recurring amount</option>
            <option value="schedule">Schedule (amount per period)</option>
          </Select>
        </Field>
        {kind !== "one_off" && (
          <Field label="Every">
            <Select aria-label="Commitment cadence" value={cadence} disabled={editing}
              onChange={(e) => setCadence(e.target.value as "monthly" | "quarterly")}>
              <option value="monthly">Month</option>
              <option value="quarterly">Quarter</option>
            </Select>
          </Field>
        )}
        {kind === "one_off" && (
          <Field label="Expected in (optional)" hint="Until then, nothing is due yet.">
            <Input aria-label="Expected month" type="month" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
          </Field>
        )}
        {kind === "recurring" && (
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="First period">
              <Input aria-label="First period" type="month" value={startsOn} onChange={(e) => setStartsOn(e.target.value)} />
            </Field>
            <Field label="Last period (optional)" hint="Leave empty while it has no end.">
              <Input aria-label="Last period" type="month" value={endsOn} onChange={(e) => setEndsOn(e.target.value)} />
            </Field>
          </div>
        )}
        {needsAmounts && (
          <Field label={kind === "recurring" ? "Amount each period" : "Amount"}>
            <TokenAmountRows rows={rows} options={options} onChange={setRows} label="Commitment" />
          </Field>
        )}
        <Field label="Link (optional)">
          <Input aria-label="Commitment link" value={url} placeholder="https://" onChange={(e) => setUrl(e.target.value)} />
        </Field>
        <Field label="Note (optional)">
          <Textarea aria-label="Commitment note" value={note} maxLength={500} rows={2} onChange={(e) => setNote(e.target.value)} />
        </Field>
        <ErrorText error={save.error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={save.busy}>Cancel</Button>
          <Button loading={save.busy} disabled={!ready} onClick={() => void submit()}>
            {editing ? "Save" : kind === "schedule" ? "Add and import periods" : "Add commitment"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
