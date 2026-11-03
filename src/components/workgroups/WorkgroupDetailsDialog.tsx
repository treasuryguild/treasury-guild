"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useTreasuries } from "@/hooks/useTreasuries";
import type { WorkgroupDetails } from "@/hooks/useWorkgroups";
import { browserClient } from "@/lib/supabase/browser";
import { routes } from "@/lib/routes";
import { Button, ErrorText, Field, Input, Modal, SourceBadge, Textarea } from "@/components/ui";
import { WorkgroupLifecycleDialog } from "./WorkgroupLifecycleDialog";
import { WalletRouting } from "./WalletRouting";

export function WorkgroupDetailsDialog({ workgroup, communityId, slug, onSaved, onClose, onLifecycleChanged }: {
  workgroup: WorkgroupDetails;
  communityId: string;
  slug: string;
  onSaved: (workgroup: WorkgroupDetails) => void;
  onClose: () => void;
  onLifecycleChanged: (action: "archive" | "restore" | "delete") => void;
}) {
  const titleId = useId();
  const [name, setName] = useState(workgroup.name);
  const [description, setDescription] = useState(workgroup.description ?? "");
  const [managingLifecycle, setManagingLifecycle] = useState(false);
  const archived = !!workgroup.archived_at;
  const treasuries = useTreasuries(communityId);
  const save = useAsyncAction("Could not save workgroup details. Please try again.");
  const treasuryList = treasuries.data ?? [];

  async function submit() {
    if (save.busy || archived) return;
    if (!name.trim()) {
      save.setError("Enter a workgroup or project name.");
      return;
    }
    const updated = await save.run(async () => {
      const { data, error } = await browserClient()
        .from("workgroups")
        .update({ name: name.trim(), description: description.trim() || null })
        .eq("id", workgroup.id)
        .eq("community_id", communityId)
        .select("id, name, description, kind, treasury_id, archived_at")
        .single();
      if (error) throw new Error(error.message);
      if (!data) throw new Error("The workgroup could not be updated. Check your admin access and try again.");
      return data as WorkgroupDetails;
    });
    if (updated) onSaved(updated);
  }

  if (managingLifecycle) return <WorkgroupLifecycleDialog workgroup={workgroup} slug={slug}
    onClose={() => setManagingLifecycle(false)} onChanged={onLifecycleChanged} />;

  return (
    <Modal open onClose={onClose} busy={save.busy} labelledBy={titleId} scroll>
      <h2 id={titleId} className="mb-2 text-lg font-medium">Edit workgroup / project details</h2>
      <p className="mb-5 text-sm text-zinc-400">{archived
        ? "This workgroup is archived. Restore it to edit its details."
        : "Update the name, purpose, and payment wallet for this workgroup or project."}</p>
      <form onSubmit={(event) => { event.preventDefault(); void submit(); }} className="space-y-4">
        <Field label="Name">
          <Input aria-label="Name" autoFocus required value={name} disabled={save.busy || archived} onChange={(event) => setName(event.target.value)} />
        </Field>
        <Field label="Description" hint="Describe the purpose, scope, or goals of this workgroup or project.">
          <Textarea aria-label="Description" rows={4} value={description} disabled={save.busy || archived} onChange={(event) => setDescription(event.target.value)} />
        </Field>
        <div className="flex flex-wrap items-center gap-2 text-sm text-zinc-400">
          Board source <SourceBadge source={workgroup.kind} />
          <Link href={routes.githubSettings(slug)} className="text-indigo-400 hover:underline">Manage GitHub connections</Link>
        </div>
        <div role="status" aria-live="polite"><ErrorText error={save.error ?? treasuries.error} /></div>
        <div className="flex justify-end gap-2 pt-2">
          <Button type="button" variant="secondary" disabled={save.busy} onClick={onClose}>Cancel</Button>
          {!archived && <Button type="submit" loading={save.busy}>{save.busy ? "Saving…" : "Save changes"}</Button>}
        </div>
      </form>
      {!archived && (
        <div className="mt-5">
          <WalletRouting workgroup={workgroup} treasuries={treasuryList} disabled={save.busy || treasuries.loading || !!treasuries.error}
            onChanged={(treasuryId, effective) => {
              // A change for the current period is already cached on the row.
              if (effective === "current") onSaved({ ...workgroup, treasury_id: treasuryId });
            }} />
        </div>
      )}
      <div className="mt-5 border-t border-zinc-700 pt-4">
        <Button variant="ghost" disabled={save.busy} onClick={() => setManagingLifecycle(true)}>
          {archived ? "Restore / delete" : "Archive / delete"}
        </Button>
      </div>
    </Modal>
  );
}
