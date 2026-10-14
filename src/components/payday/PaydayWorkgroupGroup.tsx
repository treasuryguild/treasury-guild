"use client";

import type { ReactNode } from "react";
import { isReady } from "@/lib/payday/selection";
import { describeTotals, summarizeSelection } from "@/lib/payday/summary";
import type { PayableTask } from "@/lib/payday/types";
import type { PaydayGroup } from "@/lib/payday/view";
import { Button } from "@/components/ui";

/**
 * One workgroup's tasks on Payday. Select all / Clear act on the ready tasks
 * listed, so a filtered view never changes tasks it does not show.
 */
export function PaydayWorkgroupGroup({
  group,
  selected,
  onSetSelected,
  renderRow,
}: {
  group: PaydayGroup;
  selected: ReadonlySet<string>;
  onSetSelected: (taskIds: string[], checked: boolean) => void;
  renderRow: (task: PayableTask) => ReactNode;
}) {
  const listedReady = group.visible.filter(isReady).map((t) => t.id);
  const allListedSelected = listedReady.every((id) => selected.has(id));
  const noneListedSelected = listedReady.every((id) => !selected.has(id));
  const subtotal = describeTotals(summarizeSelection(group.scope, selected).totals);

  return (
    <section className="space-y-2">
      <div className="flex flex-wrap items-center justify-between gap-2 px-1 pt-2">
        <div>
          <h2 className="text-sm font-semibold text-zinc-200">{group.name}</h2>
          <p className="text-xs text-zinc-500">
            {group.selectedCount} of {group.scope.length} selected
            {group.attentionCount > 0 && (
              <span className="text-amber-500"> · {group.attentionCount} need attention</span>
            )}
            {subtotal && <span className="text-zinc-400"> · {subtotal}</span>}
          </p>
        </div>
        {listedReady.length > 0 && (
          <div className="flex gap-2">
            <Button
              variant="ghost"
              disabled={allListedSelected}
              onClick={() => onSetSelected(listedReady, true)}
            >
              Select all
            </Button>
            <Button
              variant="ghost"
              disabled={noneListedSelected}
              onClick={() => onSetSelected(listedReady, false)}
            >
              Clear
            </Button>
          </div>
        )}
      </div>
      {group.visible.map(renderRow)}
    </section>
  );
}
