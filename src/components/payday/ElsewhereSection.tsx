"use client";

import type { ReactNode } from "react";
import type { TreasurySummary } from "@/lib/db/types";
import type { PayableTask } from "@/lib/payday/types";
import { Button } from "@/components/ui";

/**
 * Tasks the selected treasury may not pay, grouped by the treasury that
 * must: listed apart (collapsed) rather than dropped, so none is forgotten.
 */
export function ElsewhereSection({
  elsewhere,
  total,
  treasuries,
  open,
  onOpenChange,
  onPayFrom,
  renderRow,
}: {
  elsewhere: Map<string, PayableTask[]>;
  /** Every task routed elsewhere, filters ignored. */
  total: number;
  treasuries: TreasurySummary[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onPayFrom: (treasuryId: string) => void;
  renderRow: (task: PayableTask, treasuryName: string) => ReactNode;
}) {
  if (total === 0) return null;
  const nameOf = (id: string) => treasuries.find((t) => t.id === id)?.name ?? "another wallet";
  // Treasury order as in the picker; an unknown id (not loaded) goes last.
  const order = (id: string) => {
    const i = treasuries.findIndex((t) => t.id === id);
    return i < 0 ? treasuries.length : i;
  };
  const entries = [...elsewhere].sort(([a], [b]) => order(a) - order(b));

  return (
    <details
      className="mt-6"
      open={open}
      onToggle={(e) => onOpenChange(e.currentTarget.open)}
    >
      <summary className="cursor-pointer px-1 text-sm text-zinc-400">
        {total} {total === 1 ? "task is" : "tasks are"} paid from other treasuries
      </summary>
      <div className="mt-3 space-y-4">
        {entries.length === 0 && (
          <p className="px-1 text-xs text-zinc-500">None match these filters.</p>
        )}
        {entries.map(([treasuryId, tasks]) => (
          <section key={treasuryId} className="space-y-2">
            <div className="flex flex-wrap items-center justify-between gap-2 px-1">
              <h2 className="text-sm font-semibold text-zinc-300">
                {nameOf(treasuryId)} <span className="font-normal text-zinc-500">· {tasks.length}</span>
              </h2>
              {treasuries.some((t) => t.id === treasuryId) && (
                <Button variant="secondary" onClick={() => onPayFrom(treasuryId)}>
                  Pay from {nameOf(treasuryId)}
                </Button>
              )}
            </div>
            {tasks.map((t) => renderRow(t, nameOf(treasuryId)))}
          </section>
        ))}
      </div>
    </details>
  );
}
