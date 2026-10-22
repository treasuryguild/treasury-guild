"use client";

// Card for a live GitHub project item that has NOT been imported as a task
// (didn't match the import filter, or is a draft/PR). Managers can open it
// to edit the issue on GitHub, and drag it between project columns; drafts
// and pull requests stay read-only and open nothing.

import { Badge } from "@/components/ui";
import type { MergedBoardItem } from "@/lib/boardTypes";

export function LiveItemCard({
  item,
  canManage = false,
  onEdit,
  onDragStart,
}: {
  item: MergedBoardItem;
  canManage?: boolean;
  onEdit?: (item: MergedBoardItem) => void;
  /** Present only when a manager may drag it to another project column. */
  onDragStart?: (item: MergedBoardItem) => void;
}) {
  const editable = canManage && !item.draft && !item.isPullRequest;
  const draggable = editable && !!onDragStart;
  return (
    <div
      draggable={draggable}
      onDragStart={() => draggable && onDragStart!(item)}
      onClick={() => editable && onEdit?.(item)}
      className={`rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 text-sm ${
        editable ? `${draggable ? "cursor-grab" : "cursor-pointer"} hover:border-indigo-600` : ""
      }`}
    >
      {item.url ? (
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer"
          className="hover:text-indigo-400"
          onClick={(e) => e.stopPropagation()}
        >
          {item.title}
        </a>
      ) : (
        <p>{item.title}</p>
      )}
      <p className="mt-1 text-xs text-zinc-500">
        {item.number != null && <span>#{item.number}</span>}
        {item.assigneeLogins.length > 0 && (
          <span className="ml-2 text-zinc-400">
            {item.assigneeLogins.map((l) => `@${l}`).join(" ")}
          </span>
        )}
      </p>
      {(Object.keys(item.amounts).length > 0 ||
        item.draft ||
        item.isPullRequest) && (
        <div className="mt-2 flex flex-wrap items-center gap-2">
          {Object.entries(item.amounts).map(([field, value]) => (
            <span key={field} className="text-xs text-zinc-400">
              {value} {field}
            </span>
          ))}
          {item.draft && <Badge>draft</Badge>}
          {item.isPullRequest && <Badge>PR</Badge>}
        </div>
      )}
    </div>
  );
}
