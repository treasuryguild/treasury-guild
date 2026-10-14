"use client";

// Add or edit a funding source: a name, what it is, and a link.
import { useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { FundingCreatedResponse, OkResponse } from "@/lib/api/types";
import type { FundingSourceRow } from "@/lib/db/types";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { Button, ErrorText, Field, Input, Modal, Textarea } from "@/components/ui";

export function FundingSourceDialog({ communityId, source, onClose, onSaved }: {
  communityId: string;
  /** Edit this source; add a new one when absent. */
  source?: FundingSourceRow;
  onClose: () => void;
  onSaved: () => void;
}) {
  const [name, setName] = useState(source?.name ?? "");
  const [description, setDescription] = useState(source?.description ?? "");
  const [url, setUrl] = useState(source?.url ?? "");
  const save = useAsyncAction("Failed to save the funding source");

  async function submit() {
    const body = { name: name.trim(), description: description.trim() || null, url: url.trim() || null };
    const result = await save.run<unknown>(() => source
      ? apiFetch<OkResponse>(`/api/funding/sources/${source.id}`, { method: "PATCH", body })
      : apiFetch<FundingCreatedResponse>("/api/funding/sources", { body: { communityId, ...body } }));
    if (result) onSaved();
  }

  return (
    <Modal open onClose={onClose} busy={save.busy} title={source ? "Edit funding source" : "Add a funding source"}>
      <div className="space-y-4">
        <Field label="Name" hint="Who funds you, for example Project Catalyst or the treasury that releases your monthly allocation.">
          <Input aria-label="Funding source name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
        </Field>
        <Field label="Description (optional)">
          <Textarea aria-label="Funding source description" value={description} maxLength={500} rows={3}
            onChange={(e) => setDescription(e.target.value)} />
        </Field>
        <Field label="Link (optional)">
          <Input aria-label="Funding source link" value={url} placeholder="https://" onChange={(e) => setUrl(e.target.value)} />
        </Field>
        <ErrorText error={save.error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={save.busy}>Cancel</Button>
          <Button loading={save.busy} disabled={!name.trim()} onClick={() => void submit()}>{source ? "Save" : "Add source"}</Button>
        </div>
      </div>
    </Modal>
  );
}
