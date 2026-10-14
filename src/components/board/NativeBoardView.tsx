"use client";

import { useState } from "react";
import { canDropTask, isTaskDraggable, type BoardTask } from "@/lib/boardTypes";
import type { BoardColumnRow } from "@/lib/db/types";
import { Input } from "@/components/ui";
import { BoardColumn } from "./BoardColumn";
import { TaskCard } from "./TaskCard";

/** Drag-and-drop kanban for app-native workgroups. */
export function NativeBoardView({
  columns,
  tasks,
  canManage,
  onMove,
  onAdd,
  onEdit,
}: {
  columns: BoardColumnRow[];
  tasks: BoardTask[];
  canManage: boolean;
  onMove: (taskId: string, columnId: string) => void;
  onAdd: (columnId: string, title: string) => Promise<boolean>;
  onEdit: (task: BoardTask) => void;
}) {
  const [dragging, setDragging] = useState<string | null>(null);
  /** Draft "add task" text, keyed by column id so each column has its own input. */
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const draggingTask = dragging ? (tasks.find((t) => t.id === dragging) ?? null) : null;

  function setDraft(columnId: string, value: string) {
    setDrafts((d) => ({ ...d, [columnId]: value }));
  }

  async function add(columnId: string) {
    if (await onAdd(columnId, drafts[columnId] ?? "")) setDraft(columnId, "");
  }

  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-5">
      {columns.map((col) => {
        // The Paid column is filled by the confirm poller: no drops, no adds.
        const droppable = !!draggingTask && canDropTask(draggingTask, col);
        return (
          <BoardColumn
            key={col.id}
            name={col.name}
            payable={col.marks_payable}
            paid={col.marks_paid}
            highlight={droppable}
            onDrop={
              col.marks_paid
                ? undefined
                : () => {
                    if (dragging && canManage && droppable) onMove(dragging, col.id);
                    setDragging(null);
                  }
            }
            footer={
              canManage && !col.marks_paid ? (
                <div className="mt-3 flex gap-1">
                  <Input
                    value={drafts[col.id] ?? ""}
                    onChange={(e) => setDraft(col.id, e.target.value)}
                    placeholder="Add task…"
                    onKeyDown={(e) => e.key === "Enter" && void add(col.id)}
                  />
                </div>
              ) : undefined
            }
          >
            {tasks
              .filter((t) => t.column_id === col.id)
              .map((t) => (
                <TaskCard
                  key={t.id}
                  task={t}
                  canManage={canManage}
                  onEdit={onEdit}
                  onDragStart={isTaskDraggable(t) ? setDragging : undefined}
                />
              ))}
          </BoardColumn>
        );
      })}
    </div>
  );
}
