"use client";

// One task, rendered the same way on native kanban columns and GitHub
// status-grouped columns. Amount chips fall back to the legacy ADA bounty.

import { Badge } from "@/components/ui";
import { assigneeLabel, sortedAssignees } from "@/lib/assignees";
import type { BoardTask } from "@/lib/boardTypes";
import { PayState, TaskSource } from "@/lib/constants";
import { formatLovelace } from "@/lib/format";

/** "@alice, bob (@bobby), addr…" — unlinked assignees flagged in amber. */
function AssigneeLine({ task }: { task: BoardTask }) {
  const assignees = sortedAssignees(task.task_assignees);
  if (assignees.length === 0) return null;
  return (
    <p className="mt-1 text-xs text-zinc-500">
      {assignees.map((a, i) => (
        <span key={a.id}>
          {i > 0 && ", "}
          <span className={a.wallet_address ? "text-zinc-400" : "text-amber-500/70"}>
            {assigneeLabel(a)}
            {a.wallet_address ? "" : " (no wallet linked)"}
          </span>
        </span>
      ))}
    </p>
  );
}

export function AmountChips({ task }: { task: BoardTask }) {
  if (task.amounts && Object.keys(task.amounts).length > 0) {
    return (
      <>
        {Object.entries(task.amounts).map(([field, value]) => (
          <span key={field} className="text-xs text-zinc-400">
            {value} {field}
          </span>
        ))}
      </>
    );
  }
  if (task.bounty_lovelace) {
    return (
      <span className="text-xs text-zinc-400">
        {formatLovelace(task.bounty_lovelace)}
      </span>
    );
  }
  return <span className="text-xs text-amber-500/70">no bounty</span>;
}

export function TaskCard({
  task,
  canManage,
  onEdit,
  onDragStart,
}: {
  task: BoardTask;
  canManage: boolean;
  onEdit?: (task: BoardTask) => void;
  /** Present only on draggable (native) boards. */
  onDragStart?: (taskId: string) => void;
}) {
  const draggable = canManage && !!onDragStart;
  const isGithub = task.source === TaskSource.Github;
  return (
    <div
      draggable={draggable}
      onDragStart={() => draggable && onDragStart!(task.id)}
      onClick={() => canManage && onEdit?.(task)}
      className={`glass-panel rounded-xl p-3 text-sm ${
        canManage
          ? `${draggable ? "cursor-grab" : "cursor-pointer"} hover:border-indigo-600`
          : "cursor-default"
      }`}
    >
      <p>
        <span className="mr-1.5 font-mono text-xs text-zinc-500">#{task.number}</span>
        {isGithub && task.gh_url ? (
          <a
            href={task.gh_url}
            target="_blank"
            rel="noreferrer"
            className="hover:text-indigo-400"
            onClick={(e) => e.stopPropagation()}
          >
            {task.title}
          </a>
        ) : (
          task.title
        )}
      </p>
      {isGithub && (
        <p className="mt-1 text-xs text-zinc-500">
          {(task.gh_labels ?? []).join(", ") || "no labels"}
        </p>
      )}
      <AssigneeLine task={task} />
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <AmountChips task={task} />
        {task.pay_state !== PayState.None && (
          <Badge tone={task.pay_state === PayState.Payable ? "green" : "blue"}>
            {task.pay_state}
          </Badge>
        )}
        {task.chain_number !== null && (
          <Badge>
            {task.chain_number === task.number ? "Imported" : `Imported, on-chain #${task.chain_number}`}
          </Badge>
        )}
      </div>
    </div>
  );
}
