"use client";

// A schedule's amount per period. Import it from a funder's release plan CSV
// (ScheduleCsvImport), then adjust single periods. Saving replaces the whole
// schedule at once.
import { useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { FundingScheduleResponse } from "@/lib/api/types";
import { formatQuantity, scaleDecimal } from "@/lib/assets";
import { periodLabel } from "@/lib/budgets";
import { downloadText } from "@/lib/browser/download";
import type { FundingCommitmentRow, FundingPeriodRow } from "@/lib/db/types";
import type { FundingTokenOption } from "@/lib/funding/display";
import { formatFundingAmount } from "@/lib/funding/display";
import type { SchedulePeriod } from "@/lib/funding/schedule";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { Button, ErrorText, Field, Input, Modal, WarningText } from "@/components/ui";
import { ScheduleCsvImport } from "./ScheduleCsvImport";

/** month → unit → display amount */
type Grid = Record<string, Record<string, string>>;

/** A token's total over the periods, in base units; cells that do not scale are left out (the server refuses them). */
function columnTotal(grid: Grid, months: readonly string[], unit: string, options: readonly FundingTokenOption[]): string {
  const decimals = options.find((o) => o.unit === unit)?.decimals ?? 0;
  let sum = 0n;
  for (const month of months) {
    const raw = grid[month]?.[unit];
    if (!raw) continue;
    try { sum += scaleDecimal(raw, decimals); } catch { /* shown as typed */ }
  }
  return sum.toString();
}

function gridFrom(periods: readonly FundingPeriodRow[]): Grid {
  const grid: Grid = {};
  for (const period of periods) {
    grid[period.starts_on.slice(0, 7)] = Object.fromEntries(
      period.amounts.map((a) => [a.unit, formatQuantity(BigInt(a.amount), a.decimals)]));
  }
  return grid;
}

export function ScheduleEditor({ commitment, periods, options, onClose, onSaved }: {
  commitment: FundingCommitmentRow;
  periods: readonly FundingPeriodRow[];
  options: readonly FundingTokenOption[];
  onClose: () => void;
  onSaved: () => void;
}) {
  const [grid, setGrid] = useState<Grid>(() => gridFrom(periods.filter((p) => p.commitment_id === commitment.id)));
  const [newMonth, setNewMonth] = useState("");
  const save = useAsyncAction("Failed to save the schedule");
  const cadence = commitment.cadence ?? "monthly";

  const months = Object.keys(grid).sort();
  const units = [...new Set(months.flatMap((m) => Object.keys(grid[m]!)))];

  /** The imported tokens' amounts come from the file; other tokens stay. */
  function applyImport(imported: SchedulePeriod[], importedUnits: string[]) {
    setGrid((current) => {
      const next: Grid = {};
      for (const [month, cells] of Object.entries(current)) {
        const rest = { ...cells };
        for (const unit of importedUnits) delete rest[unit];
        if (Object.keys(rest).length > 0) next[month] = rest;
      }
      for (const period of imported) {
        next[period.month] = { ...(next[period.month] ?? {}), ...Object.fromEntries(period.amounts.map((a) => [a.unit, a.amount])) };
      }
      return next;
    });
  }

  function setCell(month: string, cellUnit: string, amount: string) {
    setGrid((current) => ({ ...current, [month]: { ...current[month], [cellUnit]: amount.trim() } }));
  }

  function download() {
    const header = ["month", ...units.map((u) => options.find((o) => o.unit === u)?.ticker ?? u)];
    const lines = months.map((m) => [m, ...units.map((u) => grid[m]![u] ?? "")].join(","));
    downloadText(`${commitment.name.replace(/[^\w-]+/g, "-")}-schedule.csv`, [header.join(","), ...lines, ""].join("\r\n"), "text/csv");
  }

  async function submit() {
    const body = {
      periods: months
        .map((month) => ({
          month,
          amounts: Object.entries(grid[month]!).filter(([, amount]) => amount !== "" && /[1-9]/.test(amount))
            .map(([cellUnit, amount]) => ({ unit: cellUnit, amount })),
        }))
        .filter((period) => period.amounts.length > 0),
    };
    const result = await save.run(() => apiFetch<FundingScheduleResponse>(`/api/funding/commitments/${commitment.id}/schedule`, {
      body,
    }));
    if (result) onSaved();
  }

  return (
    <Modal open onClose={onClose} busy={save.busy} scroll className="w-[min(48rem,95vw)] max-w-none" title={`Schedule: ${commitment.name}`}>
      <div className="space-y-5">
        <ScheduleCsvImport cadence={cadence} options={options} onUse={applyImport} />

        <section className="space-y-2">
          <div className="flex items-center justify-between gap-2">
            <h3 className="text-sm font-medium">Periods ({months.length})</h3>
            {months.length > 0 && <Button variant="ghost" className="text-sm" onClick={download}>Download CSV</Button>}
          </div>
          {months.length === 0 ? (
            <p className="text-sm text-zinc-500">No periods yet. Load a CSV above or add a period below.</p>
          ) : (
            <div className="max-h-80 overflow-auto rounded-lg border border-zinc-800">
              <table className="w-full text-left text-sm">
                <thead className="sticky top-0 bg-[var(--option-background)] text-xs text-zinc-500">
                  <tr>
                    <th className="px-3 py-2 font-normal">Period</th>
                    {units.map((u) => <th key={u} className="px-3 py-2 font-normal">{options.find((o) => o.unit === u)?.ticker ?? u.slice(-8)}</th>)}
                    <th className="px-3 py-2"><span className="sr-only">Actions</span></th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-zinc-800">
                  {months.map((month) => (
                    <tr key={month}>
                      <td className="whitespace-nowrap px-3 py-1">{periodLabel(month, cadence)}</td>
                      {units.map((u) => (
                        <td key={u} className="px-3 py-1">
                          <Input aria-label={`${month} ${u} amount`} inputMode="decimal" className="font-mono text-xs"
                            value={grid[month]![u] ?? ""} onChange={(e) => setCell(month, u, e.target.value)} />
                        </td>
                      ))}
                      <td className="px-3 py-1 text-right">
                        <Button variant="ghost" className="!px-2 !py-1 text-xs"
                          onClick={() => setGrid((current) => { const next = { ...current }; delete next[month]; return next; })}>
                          Remove
                        </Button>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-end">
            <Field label="Add a period" className="sm:max-w-48">
              <Input aria-label="New period month" type="month" value={newMonth} onChange={(e) => setNewMonth(e.target.value)} />
            </Field>
            <Button variant="secondary" disabled={!newMonth || !!grid[newMonth]}
              onClick={() => { setGrid((current) => ({ ...current, [newMonth]: { [units[0] ?? options[0]?.unit ?? "lovelace"]: "" } })); setNewMonth(""); }}>
              Add period
            </Button>
          </div>
          {cadence === "quarterly" && <WarningText small>Quarterly periods start in January, April, July or October.</WarningText>}
        </section>

        {months.length > 0 && units.length > 0 && (
          <p className="text-sm text-zinc-400">
            Total: {units.map((u) => formatFundingAmount(u, columnTotal(grid, months, u, options), options)).join(", ")}
          </p>
        )}
        <ErrorText error={save.error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={save.busy}>Cancel</Button>
          <Button loading={save.busy} onClick={() => void submit()}>Save schedule</Button>
        </div>
      </div>
    </Modal>
  );
}
