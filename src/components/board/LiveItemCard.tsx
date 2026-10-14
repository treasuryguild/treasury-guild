"use client";

// Read-only card for a live GitHub project item that has NOT been imported as
// a task (didn't match the import filter, or is a draft/PR). Mirrors
// TaskCard's styling but carries no pay state and opens nothing.

import { Badge } from "@/components/ui";
import type { MergedBoardItem } from "@/lib/boardTypes";

export function LiveItemCard({ item }: { item: MergedBoardItem }) {
  return (
    <div className="rounded-lg border border-zinc-800 bg-zinc-900/60 p-3 text-sm">
      {item.url ? (
        <a
          href={item.url}
          target="_blank"
          rel="noreferrer"
          className="hover:text-indigo-400"
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
