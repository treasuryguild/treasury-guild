"use client";

// Column shell shared by native kanban columns (droppable, with an add-task
// footer) and GitHub status groups (static).

import type { ReactNode } from "react";
import { Badge } from "@/components/ui";

export function BoardColumn({
  name,
  payable = false,
  paid = false,
  highlight = false,
  onDrop,
  footer,
  children,
}: {
  name: string;
  payable?: boolean;
  /** The Paid column: filled by the confirm poller, never a drop target. */
  paid?: boolean;
  /** Visual drop-target state while a task is being dragged. */
  highlight?: boolean;
  onDrop?: () => void;
  footer?: ReactNode;
  children: ReactNode;
}) {
  return (
    <div
      className={`glass-panel rounded-2xl p-3 ${
        highlight
          ? "border-indigo-700 bg-indigo-950/20"
          : ""
      }`}
      onDragOver={onDrop ? (e) => e.preventDefault() : undefined}
      onDrop={onDrop}
    >
      <div className="mb-3 flex min-w-0 items-center justify-between gap-2">
        <h3 className="min-w-0 text-sm font-medium">{name}</h3>
        {payable && <Badge tone="green">payable</Badge>}
        {paid && <Badge tone="blue">paid</Badge>}
      </div>
      <div className="space-y-2">{children}</div>
      {footer}
    </div>
  );
}
