"use client";

import { useState } from "react";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useAsyncData } from "@/hooks/useAsyncData";
import { apiFetch } from "@/lib/api/client";
import type { BudgetResetStatus } from "@/lib/api/types";
import { Button, ErrorText, Input } from "@/components/ui";
import { BudgetDialog } from "./BudgetSetupDialog";

export function BudgetResetDialog({ workgroupId, name, expectedRevision, onClose, onReset }: {
  workgroupId: string; name: string; expectedRevision: number;
  onClose: () => void; onReset: (revision: number) => Promise<void>;
}) {
  const [confirmation, setConfirmation] = useState("");
  const [reason, setReason] = useState("");
  const operation = useAsyncAction("Could not reset budgets. Please try again.");
  const status = useAsyncData(workgroupId, () => apiFetch<BudgetResetStatus>("/api/budgets/reset", {
    query: { workgroupId },
  }));
  const stale = !!status.data && status.data.revision !== expectedRevision;
  const blocked = !status.data || !!status.error || status.loading || !!status.data.blockedReason || !status.data.hasBudgets || stale;

  async function reset() {
    if (blocked || operation.busy || confirmation !== name || !reason.trim()) return;
    const result = await operation.run(() => apiFetch<{ revision: number }>("/api/budgets/reset", {
      body: { workgroupId, expectedRevision, confirmation, reason: reason.trim() },
    }));
    if (result) await onReset(result.revision);
    else status.reload();
  }

  return <BudgetDialog title={`Reset budgets for ${name}`} onClose={operation.busy ? () => {} : onClose}>
    <p className="mb-4 text-sm text-zinc-400">This clears all budget amounts, setups, scheduled changes, and budget history for every period, returning this workgroup to No budget configured. A community audit record keeps the previous configuration, your name, and your reason. This cannot be undone here.</p>
    {status.loading && <p role="status">Checking payment history and commitments…</p>}
    <ErrorText error={status.error} />
    {status.error && <Button variant="secondary" onClick={status.reload}>Retry</Button>}
    {status.data?.blockedReason && <p role="status" className="mb-4 text-sm text-amber-400">{status.data.blockedReason}</p>}
    {status.data && !status.data.hasBudgets && <p role="status">This workgroup has no budgets to reset.</p>}
    {stale && <p role="alert" className="mb-4 text-sm text-amber-400">Budgets changed since this worksheet loaded. Close this dialog and reload the page to review them before resetting.</p>}
    {!blocked && <>
      <label className="mb-4 block text-sm">Reason for resetting budgets
        <Input className="mt-1" maxLength={500} value={reason} disabled={operation.busy} onChange={(event) => setReason(event.target.value)} />
      </label>
      <label className="mb-4 block text-sm">Type {name} to confirm budget reset
        <Input className="mt-1" value={confirmation} disabled={operation.busy} onChange={(event) => setConfirmation(event.target.value)} />
      </label>
    </>}
    <div role="alert"><ErrorText error={operation.error} /></div>
    <div className="mt-4 flex justify-end gap-2">
      <Button variant="secondary" disabled={operation.busy} onClick={onClose}>Cancel</Button>
      <Button variant="danger" loading={operation.busy} disabled={blocked || confirmation !== name || !reason.trim()}
        onClick={() => void reset()}>Reset all budgets</Button>
    </div>
  </BudgetDialog>;
}
