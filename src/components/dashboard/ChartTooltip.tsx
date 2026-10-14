"use client";

import type { TooltipContentProps } from "recharts";
import type { ChartRow } from "@/lib/dashboardSeries";

/**
 * Tooltip that prints the exact strings a `ChartRow` carries in `labels`,
 * never the float recharts plotted. Rendered by recharts with its own props;
 * `showTotal` adds the row's `labels.total` line under several series.
 */
export function ChartTooltip({ active, payload, showTotal = false }: Partial<TooltipContentProps<number, string>> & {
  showTotal?: boolean;
}) {
  if (!active || !payload?.length) return null;
  const row = payload[0]!.payload as ChartRow;
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--surface-strong)] px-3 py-2 text-xs shadow-lg">
      <p className="font-medium">{row.label}</p>
      <ul className="mt-1 space-y-0.5">
        {payload.map((entry) => {
          const key = String(entry.dataKey).replace(/^values\./, "");
          return (
            <li key={key} className="flex items-center gap-2">
              <span className="h-2 w-2 shrink-0 rounded-sm" style={{ background: entry.color }} aria-hidden />
              <span className="text-zinc-400">{entry.name}</span>
              <span className="ml-auto pl-3 font-mono tabular-nums">{row.labels[key] ?? String(entry.value ?? "")}</span>
            </li>
          );
        })}
        {showTotal && payload.length > 1 && row.labels.total && (
          <li className="mt-1 flex items-center gap-2 border-t border-zinc-800 pt-1">
            <span className="text-zinc-400">Total</span>
            <span className="ml-auto pl-3 font-mono tabular-nums">{row.labels.total}</span>
          </li>
        )}
      </ul>
    </div>
  );
}
