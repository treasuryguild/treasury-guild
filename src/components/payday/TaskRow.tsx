"use client";

import { assigneeLabel, sortedAssignees } from "@/lib/assignees";
import { isReady, taskAmounts } from "@/lib/payday/selection";
import type { PayableTask } from "@/lib/payday/types";
import { Button, SourceBadge } from "@/components/ui";

export function TaskRow({
  task,
  selected,
  lockedByName,
  onToggle,
  onEdit,
}: {
  task: PayableTask;
  selected: boolean;
  /** Name of the other treasury this task must be paid from, if any. */
  lockedByName: string | null;
  onToggle: (checked: boolean) => void;
  /** Opens the task editor; only given to admins and the workgroup's leads. */
  onEdit?: () => void;
}) {
  const amounts = taskAmounts(task);
  const assignees = sortedAssignees(task.task_assignees);
  const ready = isReady(task) && !lockedByName;

  return (
    <label
      className={`glass-panel flex cursor-pointer flex-col items-start justify-between gap-3 rounded-2xl p-4 sm:flex-row sm:items-center ${
        selected ? "border-indigo-600 bg-indigo-950/20" : "border-zinc-800 bg-zinc-900/40"
      }`}
    >
      {/* A blocked row fades its content, not the Edit button that fixes it. */}
      <div className={`flex min-w-0 items-start gap-3 sm:items-center ${!ready ? "opacity-60" : ""}`}>
        <input
          type="checkbox"
          checked={selected}
          disabled={!ready}
          onChange={(e) => onToggle(e.target.checked)}
        />
        <div>
          <p className="text-sm">
            <span className="text-zinc-500">#{task.number}</span> {task.title}
          </p>
          <p className="mt-0.5 text-xs text-zinc-500">
            {task.workgroup.name} ·{" "}
            {assignees.length === 0 ? (
              <span className="text-amber-500">no assignees</span>
            ) : (
              assignees.map((a, i) => (
                <span key={a.id}>
                  {i > 0 && ", "}
                  <span className={a.wallet_address ? "text-zinc-400" : "text-amber-500"}>
                    {assigneeLabel(a)}
                    {a.wallet_address ? "" : " (no wallet)"}
                  </span>
                </span>
              ))
            )}
            {lockedByName && (
              <span className="ml-2 text-amber-500">paid from {lockedByName}</span>
            )}
          </p>
        </div>
      </div>
      <div className="flex flex-wrap items-center gap-2 sm:justify-end">
        <span className={`flex flex-wrap items-center gap-2 ${!ready ? "opacity-60" : ""}`}>
          <SourceBadge source={task.source} />
          {Object.keys(amounts).length > 0 ? (
            <>
              {Object.entries(amounts).map(([field, value]) => (
                <span key={field} className="text-sm font-medium">
                  {value} {field}
                </span>
              ))}
              {assignees.length > 1 && (
                <span className="text-xs text-zinc-500">each · ×{assignees.length}</span>
              )}
            </>
          ) : (
            <span className="text-xs text-amber-500">no bounty</span>
          )}
        </span>
        {onEdit && (
          // The row is a <label> for the checkbox: stop the click from toggling it.
          // A blocked task's button is highlighted: editing is how it gets unblocked.
          <Button
            type="button"
            variant={ready ? "secondary" : "primary"}
            aria-label={`Edit task: ${task.title}`}
            onClick={(e) => {
              e.preventDefault();
              onEdit();
            }}
          >
            Edit
          </Button>
        )}
      </div>
    </label>
  );
}
