"use client";

import Link from "next/link";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useAsyncData } from "@/hooks/useAsyncData";
import type { WorkgroupDetails } from "@/hooks/useWorkgroups";
import { apiFetch } from "@/lib/api/client";
import type { OkResponse, WorkgroupLifecycleStatus } from "@/lib/api/types";
import { routes } from "@/lib/routes";
import { LifecycleDialog, type LifecycleAction } from "@/components/ui";

export function WorkgroupLifecycleDialog({ workgroup, slug, onClose, onChanged }: {
  workgroup: WorkgroupDetails;
  slug: string;
  onClose: () => void;
  onChanged: (action: LifecycleAction) => void;
}) {
  const operation = useAsyncAction("Could not update this workgroup. Please try again.");
  const status = useAsyncData(workgroup.id, () => apiFetch<WorkgroupLifecycleStatus>("/api/workgroups/lifecycle", {
    query: { workgroupId: workgroup.id },
  }));
  const archived = !!status.data?.archivedAt;
  const blocked = !!status.data && (status.data.outstandingTasks > 0 || status.data.pendingPayouts > 0);

  async function submit(action: LifecycleAction, confirmation: string) {
    if (operation.busy) return;
    const result = await operation.run(() => apiFetch<OkResponse>("/api/workgroups/lifecycle", {
      body: { workgroupId: workgroup.id, action, confirmation },
    }));
    if (result) onChanged(action);
    else status.reload();
  }

  return <LifecycleDialog
    title={`Manage ${workgroup.name}`}
    noun="workgroup"
    status={{ ...status, ready: !!status.data }}
    archived={archived}
    description={archived
      ? "This workgroup is archived. Restore it to resume editing, payments, and GitHub imports."
      : "Archiving hides this workgroup from active lists and stops new tasks and GitHub imports. Its board becomes read-only. Task, budget, and payment history stays available, and an admin can restore it."}
    archiveBlocked={blocked && status.data ? <>
      Resolve {status.data.outstandingTasks} payable or queued task(s) and {status.data.pendingPayouts} pending payout(s) before archiving.{" "}
      <Link href={routes.board(slug, workgroup.id)} className="underline">View board</Link>{" · "}
      <Link href={routes.payday(slug)} className="underline">Open Payday</Link>
    </> : null}
    deletion={{
      shown: true,
      allowed: !!status.data?.canDelete,
      explanation: "This workgroup has no remaining tasks or payment records. Permanent deletion also clears all budget configuration and history, its empty board, lead assignments, and local GitHub connections. A community audit record preserves the previous budgets and who deleted the workgroup. GitHub repositories and issues are unaffected. This cannot be undone.",
      unavailable: "Permanent deletion is unavailable while this workgroup has tasks, payment records or imported payment history. Archive it, or remove eligible unpaid tasks (including archived ones) and its imported history first.",
      startLabel: "Delete empty workgroup",
      confirmText: workgroup.name,
      confirmPrompt: `Type ${workgroup.name} to confirm deletion`,
    }}
    busy={operation.busy}
    error={operation.error}
    onAction={(action, confirmation) => void submit(action, confirmation)}
    onClose={onClose}
    closeLabel="Close"
  />;
}
