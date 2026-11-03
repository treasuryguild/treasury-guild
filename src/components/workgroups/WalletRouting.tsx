"use client";

import { useState } from "react";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useAsyncData } from "@/hooks/useAsyncData";
import type { WorkgroupDetails } from "@/hooks/useWorkgroups";
import { apiFetch } from "@/lib/api/client";
import type { WorkgroupRoutingResponse, WorkgroupRoutingStatus } from "@/lib/api/types";
import { monthOf, periodLabel as budgetPeriodLabel, type BudgetCadence } from "@/lib/budgets";
import { formatDate, shortAddress } from "@/lib/format";
import { Button, ErrorText, Field, Input, Select } from "@/components/ui";

const ANY_WALLET = "";

/** "2026-10-01" → "Oct 2026" for a monthly workgroup, "Q4 2026" for a quarterly one. */
function periodLabel(startsOn: string, cadence: BudgetCadence): string {
  return budgetPeriodLabel(monthOf(startsOn), cadence);
}

/**
 * The workgroup's payment wallet over time: which wallet pays it now, a
 * change scheduled for this or the next budget period, and the history.
 * Writes go through POST /api/workgroups/routing (admin).
 */
export function WalletRouting({ workgroup, treasuries, disabled, onChanged, className = "space-y-3 border-t border-zinc-700 pt-4" }: {
  workgroup: Pick<WorkgroupDetails, "id" | "treasury_id">;
  treasuries: { id: string; name: string; archived_at?: string | null }[];
  disabled: boolean;
  onChanged: (treasuryId: string | null, effective: "current" | "next") => void;
  className?: string;
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
  // Archived wallets stay out of the list, except the one this workgroup
  // already pays from, so its name stays visible until the routing moves.
  const choices = treasuries.filter((treasury) => !treasury.archived_at || treasury.id === (workgroup.treasury_id ?? ""));

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
    <section className={className}>
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
          {treasuryId && !choices.some((treasury) => treasury.id === treasuryId) && <option value={treasuryId}>Assigned wallet</option>}
          {choices.map((treasury) => (
            <option key={treasury.id} value={treasury.id}>
              {treasury.name}{treasury.archived_at ? " (archived)" : ""}
            </option>
          ))}
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
