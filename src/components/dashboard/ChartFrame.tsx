"use client";

import type { ReactNode } from "react";
import { Card, EmptyState } from "@/components/ui";

/** Rows of the accessible twin of a chart: the same numbers as a table. */
export interface ChartTable {
  columns: string[];
  rows: string[][];
}

/** A titled chart card with an empty state and a "Data table" disclosure. */
export function ChartFrame({ title, description, height, empty, table, children }: {
  title: string;
  description?: string;
  /** Plot height in px, including the axis band, so the card never scrolls. */
  height: number;
  /** Replaces the plot when there is nothing to draw. */
  empty?: string | null;
  table: ChartTable;
  children: ReactNode;
}) {
  return (
    <Card className="min-w-0">
      <h2 className="text-lg font-medium">{title}</h2>
      {description && <p className="mt-1 text-xs text-zinc-500">{description}</p>}
      {empty ? (
        <div className="mt-4"><EmptyState card={false}>{empty}</EmptyState></div>
      ) : (
        <>
          <div className="mt-4 min-w-0" style={{ height }} role="figure" aria-label={title}>
            {children}
          </div>
          <details className="mt-3">
            <summary className="cursor-pointer text-xs text-zinc-500">Data table</summary>
            <div className="mt-2 overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr>
                    {table.columns.map((column, index) => (
                      <th key={column} className={`px-2 py-1 font-medium text-zinc-400 first:pl-0 ${index > 0 ? "text-right" : "text-left"}`}>
                        {column}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {table.rows.map((row, rowIndex) => (
                    <tr key={rowIndex} className="border-t border-zinc-800">
                      {row.map((cell, cellIndex) => (
                        <td key={cellIndex} className={`px-2 py-1 first:pl-0 ${cellIndex > 0 ? "text-right font-mono tabular-nums" : ""}`}>
                          {cell}
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </details>
        </>
      )}
    </Card>
  );
}
