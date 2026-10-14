"use client";

import { formatUnitAmount, unitTicker, type UnitDisplay } from "@/lib/assetRegistry";
import { budgetUsagePercent } from "@/lib/budgets";
import type { BudgetTableRow, BudgetTableTotal } from "@/lib/dashboardSeries";
import { Card, EmptyState, LinkButton } from "@/components/ui";

function Usage({ spent, amount }: { spent: string; amount: string | null }) {
  if (amount === null) return <span className="text-xs text-zinc-500">No budget</span>;
  const over = BigInt(spent) > BigInt(amount);
  const percent = budgetUsagePercent(BigInt(spent), BigInt(amount));
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-14 overflow-hidden rounded-full bg-[var(--surface-inset)]" aria-hidden>
        <div className={`h-full rounded-full ${over ? "bg-red-400" : "bg-[var(--accent)]"}`} style={{ width: `${percent}%` }} />
      </div>
      <span className={`font-mono text-xs tabular-nums ${over ? "text-red-400" : "text-zinc-400"}`}>
        {over ? "Over" : `${Math.round(percent)}%`}
      </span>
    </div>
  );
}

const NUMBER = "px-3 py-3 text-right font-mono text-sm tabular-nums whitespace-nowrap";

/** Budget, spent and balance per workgroup or treasury and token for the selected period. */
export function BudgetTable({ rows, totals, display, periodLabel, editHref }: {
  rows: BudgetTableRow[];
  totals: BudgetTableTotal[];
  display: UnitDisplay;
  periodLabel: string;
  editHref: string;
}) {
  return (
    <section className="min-w-0">
      <h2 className="mb-3 text-lg font-semibold">Budget vs spending · {periodLabel}</h2>
      {rows.length === 0 ? (
        <EmptyState action={<LinkButton href={editHref} variant="secondary">Edit budgets</LinkButton>}>
          No budgets or spending in {periodLabel}.
        </EmptyState>
      ) : (
        <Card className="overflow-x-auto !p-0">
          <table className="w-full">
            <thead>
              <tr className="border-b border-zinc-800 text-xs text-zinc-400">
                <th className="px-5 py-3 text-left font-medium">Workgroup / treasury</th>
                <th className="px-3 py-3 text-left font-medium">Token</th>
                <th className="px-3 py-3 text-right font-medium">Budget</th>
                <th className="px-3 py-3 text-right font-medium">Spent</th>
                <th className="px-3 py-3 text-right font-medium">Balance</th>
                <th className="px-4 py-3 text-left font-medium">Used</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {rows.map((row) => {
                const negative = row.balance !== null && BigInt(row.balance) < 0n;
                return (
                  <tr key={row.key}>
                    <td className="px-5 py-3 text-sm">
                      <p className="font-medium leading-snug">{row.ownerName}</p>
                      {row.periodLabel && <p className="mt-0.5 text-xs text-zinc-500">{row.periodLabel} · whole quarter</p>}
                    </td>
                    <td className="px-3 py-3 text-sm">{unitTicker(row.unit, display)}</td>
                    <td className={NUMBER}>{row.amount === null ? <span className="text-zinc-500">—</span> : formatUnitAmount(row.unit, row.amount, display)}</td>
                    <td className={NUMBER}>{formatUnitAmount(row.unit, row.spent, display)}</td>
                    <td className={`${NUMBER} ${negative ? "text-red-400" : ""}`}>
                      {row.balance === null ? <span className="text-zinc-500">—</span> : formatUnitAmount(row.unit, row.balance, display)}
                    </td>
                    <td className="px-4 py-3"><Usage spent={row.spent} amount={row.amount} /></td>
                  </tr>
                );
              })}
            </tbody>
            <tfoot>
              {totals.map((total) => {
                const negative = total.balance !== null && BigInt(total.balance) < 0n;
                return (
                  <tr key={total.unit} className="border-t border-zinc-800 bg-[var(--surface-inset)] text-sm">
                    <td className="px-5 py-3 font-medium">Total</td>
                    <td className="px-3 py-3">{unitTicker(total.unit, display)}</td>
                    <td className={NUMBER}>{total.amount === null ? <span className="text-zinc-500">—</span> : formatUnitAmount(total.unit, total.amount, display)}</td>
                    <td className={NUMBER}>{formatUnitAmount(total.unit, total.spent, display)}</td>
                    <td className={`${NUMBER} ${negative ? "text-red-400" : ""}`}>
                      {total.balance === null ? <span className="text-zinc-500">—</span> : formatUnitAmount(total.unit, total.balance, display)}
                    </td>
                    <td className="px-4 py-3"><Usage spent={total.spent} amount={total.amount} /></td>
                  </tr>
                );
              })}
            </tfoot>
          </table>
        </Card>
      )}
    </section>
  );
}
