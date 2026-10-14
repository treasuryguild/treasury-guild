"use client";

import { useId, useState } from "react";
import Link from "next/link";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useAsyncData } from "@/hooks/useAsyncData";
import { useTreasuries } from "@/hooks/useTreasuries";
import type { WorkgroupDetails } from "@/hooks/useWorkgroups";
import { apiFetch } from "@/lib/api/client";
import type { WorkgroupRoutingResponse, WorkgroupRoutingStatus } from "@/lib/api/types";
import { monthOf, periodLabel as budgetPeriodLabel, type BudgetCadence } from "@/lib/budgets";
import { formatDate, shortAddress } from "@/lib/format";
import { browserClient } from "@/lib/supabase/browser";
import { routes } from "@/lib/routes";
import { Button, ErrorText, Field, Input, Modal, SourceBadge, Select, Textarea } from "@/components/ui";
import { WorkgroupLifecycleDialog } from "./WorkgroupLifecycleDialog";

const ANY_WALLET = "";

/** "2026-10-01" → "Oct 2026" for a monthly workgroup, "Q4 2026" for a quarterly one. */
function periodLabel(startsOn: string, cadence: BudgetCadence): string {
  return budgetPeriodLabel(monthOf(startsOn), cadence);
}

/**
 * The workgroup's payment wallet over time: which wallet pays it now, a
 * change scheduled for this or the next budget period, and the history.
 * Writes go through POST /api/workgroups/routing (admin); the details form
 * below never touches `treasury_id`.
 */
function WalletRouting({ workgroup, treasuries, disabled, onChanged }: {
  workgroup: WorkgroupDetails;
  treasuries: { id: string; name: string }[];
  disabled: boolean;
  onChanged: (treasuryId: string | null, effective: "current" | "next") => void;
}) {
  const routing = useAsyncData(workgroup.id, () => apiFetch<WorkgroupRoutingStatus>(
    "/api/workgroups/routing", { query: { workgroupId: workgroup.id } },
  ));
  const [treasuryId, setTreasuryId] = useState(workgroup.treasury_id ?? ANY_WALLET);
  const [effective, setEffective] = useState<"current" | "next">("next");
  const [reason, setReason] = useState("");
  const change = useAsyncAction("Could not change the payment wallet. Please try again.");
  const status = routing.data;
  const cadence = status?.cadence ?? "monthly";
  const currentBlocked = !!status?.currentBlocked;
  const chosenEffective = currentBlocked ? "next" : effective;
  const walletName = (id: string | null) => id === null ? "Any wallet"
    : treasuries.find((treasury) => treasury.id === id)?.name ?? "Assigned wallet";
  const unchanged = (treasuryId || null) === (workgroup.treasury_id ?? null) && chosenEffective === "current";

  async function submit() {
    if (change.busy || disabled) return;
    const result = await change.run(() => apiFetch<WorkgroupRoutingResponse>("/api/workgroups/routing", {
      body: { workgroupId: workgroup.id, treasuryId: treasuryId || null, effective: chosenEffective, reason: reason || undefined },
    }));
    if (!result) return;
    setReason("");
    routing.reload();
    onChanged(treasuryId || null, chosenEffective);
  }

  return (
    <section className="space-y-3 border-t border-zinc-700 pt-4">
      <div>
        <h3 className="text-sm font-medium">Payment wallet</h3>
        <p className="mt-1 text-xs text-zinc-500">
          Paid from <span className="text-zinc-300">{walletName(workgroup.treasury_id ?? null)}</span>
          {status ? ` in ${periodLabel(status.currentStart, cadence)}` : ""}. A change starts at a budget period boundary, so one period is never paid from two wallets.
        </p>
      </div>
      <Field label="Wallet" hint="Choose a wallet to restrict payouts, or allow any community wallet.">
        <Select aria-label="Payment wallet" value={treasuryId} disabled={disabled || change.busy} onChange={(event) => setTreasuryId(event.target.value)}>
          <option value={ANY_WALLET}>Any wallet</option>
          {treasuryId && !treasuries.some((treasury) => treasury.id === treasuryId) && <option value={treasuryId}>Assigned wallet</option>}
          {treasuries.map((treasury) => <option key={treasury.id} value={treasury.id}>{treasury.name}</option>)}
        </Select>
      </Field>
      <fieldset className="space-y-1 text-sm" disabled={disabled || change.busy}>
        <legend className="mb-1 text-sm text-zinc-300">Takes effect</legend>
        <label className="flex items-start gap-2">
          <input type="radio" name="effective" value="current" className="mt-1" checked={chosenEffective === "current"} disabled={currentBlocked}
            onChange={() => setEffective("current")} />
          <span>
            This period{status ? ` (${periodLabel(status.currentStart, cadence)})` : ""}
            {currentBlocked && <span className="block text-xs text-zinc-500">Already has payouts, so the wallet stays until the period ends.</span>}
          </span>
        </label>
        <label className="flex items-start gap-2">
          <input type="radio" name="effective" value="next" className="mt-1" checked={chosenEffective === "next"} onChange={() => setEffective("next")} />
          <span>Next period{status ? ` (${periodLabel(status.nextStart, cadence)})` : ""}</span>
        </label>
      </fieldset>
      <Field label="Reason (optional)">
        <Input aria-label="Reason" value={reason} disabled={disabled || change.busy} maxLength={500} onChange={(event) => setReason(event.target.value)} placeholder="e.g. Dev now has its own wallet" />
      </Field>
      <div role="status" aria-live="polite"><ErrorText error={change.error ?? routing.error} /></div>
      <div className="flex justify-end">
        <Button type="button" variant="secondary" loading={change.busy} disabled={disabled || unchanged || routing.loading} onClick={() => void submit()}>
          {change.busy ? "Saving…" : "Change wallet"}
        </Button>
      </div>
      {status && status.history.length > 0 && (
        <details className="text-xs text-zinc-500">
          <summary className="cursor-pointer">Wallet history</summary>
          <ul className="mt-2 space-y-1">
            {status.history.map((item) => (
              <li key={item.id}>
                <span className="text-zinc-300">{walletName(item.treasuryId)}</span> from {periodLabel(item.startsOn, cadence)}
                {item.createdBy === "migration" ? "" : ` · ${shortAddress(item.createdBy)}, ${formatDate(item.createdAt)}`}
                {item.reason ? ` · ${item.reason}` : ""}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  );
}

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
