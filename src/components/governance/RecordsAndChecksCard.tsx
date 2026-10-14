"use client";

// The community-level governance settings (migration 0059): whether frozen
// tally documents are published to an outside store, and what a spend that
// fails the budget check does. Admins edit; members read. Turning
// publication on is confirmed first, because a published document cannot be
// taken back.
import { useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { OkResponse } from "@/lib/api/types";
import type { DocumentStoreName } from "@/lib/db/types";
import { SpendCheckMode, type GovernanceCommunitySettings } from "@/lib/governance/rules";
import { STORE_LABELS } from "@/lib/storage/locator";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { Button, Card, ConfirmDialog, ErrorText, Field, NoticeText, Select, SectionTitle } from "@/components/ui";

export function RecordsAndChecksCard({ communityId, initial, canEdit, onSaved }: {
  communityId: string;
  initial: GovernanceCommunitySettings;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const [store, setStore] = useState<DocumentStoreName | null>(initial.documentStore);
  const [spendCheck, setSpendCheck] = useState(initial.spendCheck);
  const [confirming, setConfirming] = useState(false);
  const [saved, setSaved] = useState(false);
  const save = useAsyncAction("Failed to save the settings");
  const off = !canEdit;
  const turningOn = store !== null && initial.documentStore !== store;

  async function submit() {
    setConfirming(false);
    const ok = await save.run(() => apiFetch<OkResponse>("/api/governance/community-settings", {
      body: { communityId, documentStore: store, spendCheck },
    }));
    if (ok) {
      setSaved(true);
      onSaved();
    }
  }

  return (
    <Card className="space-y-4">
      <SectionTitle>Records and checks</SectionTitle>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Publish signed tallies" size="sm"
          hint="Every proposal that reached a vote gets a frozen, hashed record of its ballots and result, kept here for members. Publishing also puts a copy where anyone can fetch it by its hash. Applies to proposals closing from when it is turned on.">
          <Select aria-label="Publish signed tallies" value={store ?? ""} disabled={off}
            onChange={(e) => { setSaved(false); setStore((e.target.value || null) as DocumentStoreName | null); }}>
            <option value="">Keep in Treasury Guild only</option>
            {Object.entries(STORE_LABELS).map(([name, label]) => <option key={name} value={name}>{label}</option>)}
          </Select>
        </Field>
        <Field label="A spend that does not fit the voted budgets" size="sm"
          hint="With budget consent on, every payout and payment is checked against the budgets in force before it is built.">
          <Select aria-label="Spending check" value={spendCheck} disabled={off}
            onChange={(e) => { setSaved(false); setSpendCheck(e.target.value as SpendCheckMode); }}>
            <option value={SpendCheckMode.Warn}>Warn the signers on the transaction page</option>
            <option value={SpendCheckMode.Refuse}>Refuse to build it</option>
          </Select>
        </Field>
      </div>
      {canEdit && (
        <div className="flex flex-wrap items-center justify-end gap-3">
          <ErrorText error={save.error} />
          <NoticeText>{saved ? "Saved." : null}</NoticeText>
          <Button loading={save.busy} onClick={() => (turningOn ? setConfirming(true) : void submit())}>Save</Button>
        </div>
      )}
      <ConfirmDialog
        open={confirming}
        title={`Publish signed tallies to ${store ? STORE_LABELS[store] : ""}?`}
        confirmLabel="Publish from now on"
        busy={save.busy}
        onCancel={() => setConfirming(false)}
        onConfirm={() => void submit()}
      >
        Each published record holds every voter&apos;s wallet address, choice, reason and signature for that proposal. A copy on{" "}
        {store ? STORE_LABELS[store] : "the store"} is public and cannot be taken back: turning this off later stops new
        records from being published but does not remove the ones already there.
      </ConfirmDialog>
    </Card>
  );
}
