"use client";

import { LifecycleDialog, type LifecycleAction } from "@/components/ui";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useAsyncData } from "@/hooks/useAsyncData";
import type { BoardTask } from "@/lib/boardTypes";
import { browserClient } from "@/lib/supabase/browser";

export interface TaskLifecycleStatus {
  archivedAt: string | null;
  canArchive: boolean;
  canDelete: boolean;
}
export type TaskLifecycleAction = LifecycleAction;

export function TaskLifecycleDialog({ task, onClose, onChanged }: {
  task: BoardTask;
  onClose: () => void;
  onChanged: (action: TaskLifecycleAction) => void;
}) {
  const operation = useAsyncAction("Could not update this task. Please try again.");
  const status = useAsyncData(task.id, async () => {
    const { data, error } = await browserClient().rpc("task_lifecycle_status", { p_task_id: task.id });
    if (error) throw new Error(error.message);
    return data as TaskLifecycleStatus;
  });
  const archived = !!status.data?.archivedAt;

  async function submit(action: TaskLifecycleAction, confirmation: string) {
    if (operation.busy) return;
    const ok = await operation.run(async () => {
      const { error } = await browserClient().rpc("change_task_lifecycle", {
        p_task_id: task.id, p_action: action, p_confirmation: confirmation,
      });
      if (error) throw new Error(error.message);
      return true;
    });
    if (ok) onChanged(action);
    else status.reload();
  }

  return <LifecycleDialog
    title={task.title}
    noun="task"
    status={{ ...status, ready: !!status.data }}
    archived={archived}
    description={archived
      ? "This task is archived. Restore it to its previous board column and payment status. If it was payable, it will appear in Payday again."
      : "Archive this task to remove it from the board and Payday. Its details and payment history are kept, and you can restore it from Archived tasks."}
    archiveBlocked={status.data && !status.data.canArchive ? "Resolve the pending payout before archiving this task." : null}
    deletion={{
      shown: archived,
      allowed: !!status.data?.canDelete,
      explanation: "Permanent deletion removes this task and its details. This cannot be undone.",
      unavailable: "This task has payment history and cannot be permanently deleted.",
      startLabel: "Delete task…",
      confirmText: task.title,
      confirmPrompt: "Type the task title to confirm deletion",
    }}
    busy={operation.busy}
    error={operation.error}
    onAction={(action, confirmation) => void submit(action, confirmation)}
    onClose={onClose}
  >
    {task.body && <p className="whitespace-pre-wrap break-words text-sm text-zinc-400">{task.body}</p>}
  </LifecycleDialog>;
}
