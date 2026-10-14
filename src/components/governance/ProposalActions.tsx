"use client";

// Ending a proposal early (the proposer withdraws before voting, an admin
// cancels with a reason) and retrying a failed application (admins).
import { useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { ProposalStateResponse } from "@/lib/api/types";
import { ExecutionState } from "@/lib/constants";
import type { ProposalRow } from "@/lib/db/types";
import { canCancel, canWithdraw } from "@/lib/governance/lifecycle";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { Button, ConfirmDialog, ErrorText, Field, Modal, Textarea } from "@/components/ui";

export function ProposalActions({ proposal, wallet, isAdmin, onChanged }: {
  proposal: ProposalRow;
  wallet: string | null;
  isAdmin: boolean;
  onChanged: () => void;
}) {
  const [dialog, setDialog] = useState<"withdraw" | "cancel" | null>(null);
  const [reason, setReason] = useState("");
  const action = useAsyncAction();
  const withdraw = canWithdraw(proposal, wallet);
  const cancel = canCancel(proposal, isAdmin);
  const retry = isAdmin && proposal.execution_state === ExecutionState.Failed;
  if (!withdraw && !cancel && !retry) return null;

  async function post(path: string, body?: object) {
    const done = await action.run(() => apiFetch<ProposalStateResponse>(`/api/proposals/${proposal.id}/${path}`, { method: "POST", body }));
    if (done) {
      setDialog(null);
      onChanged();
    }
  }

  return (
    <div className="flex flex-wrap items-center justify-end gap-2">
      {!dialog && <ErrorText error={action.error} />}
      {retry && <Button variant="secondary" loading={action.busy} onClick={() => void post("execute")}>Retry applying</Button>}
      {withdraw && <Button variant="secondary" onClick={() => setDialog("withdraw")}>Withdraw</Button>}
      {cancel && <Button variant="danger" onClick={() => setDialog("cancel")}>Cancel proposal</Button>}
      <ConfirmDialog open={dialog === "withdraw"} title="Withdraw this proposal?" confirmLabel="Withdraw"
        busy={action.busy} error={action.error} onCancel={() => setDialog(null)} onConfirm={() => void post("withdraw")}>
        It closes without a vote. You can make a new one later.
      </ConfirmDialog>
      <Modal open={dialog === "cancel"} onClose={() => setDialog(null)} busy={action.busy} title="Cancel this proposal">
        <div className="space-y-4">
          <p className="text-sm text-zinc-400">It closes without a result and nothing is applied. Every member sees who cancelled it and why.</p>
          <Field label="Reason">
            <Textarea aria-label="Reason for cancelling" rows={3} maxLength={500} value={reason} onChange={(e) => setReason(e.target.value)} />
          </Field>
          <ErrorText error={action.error} />
          <div className="flex justify-end gap-2">
            <Button variant="secondary" onClick={() => setDialog(null)} disabled={action.busy}>Keep it open</Button>
            <Button variant="danger" loading={action.busy} disabled={!reason.trim()}
              onClick={() => void post("cancel", { reason: reason.trim() })}>Cancel proposal</Button>
          </div>
        </div>
      </Modal>
    </div>
  );
}
