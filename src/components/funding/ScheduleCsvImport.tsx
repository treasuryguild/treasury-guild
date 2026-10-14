"use client";

// Load a release plan from a CSV: choose the column with the dates (or say
// there is none and give the first month), then which token each amount
// column is paid in, or skip it (for example another community's column).
import { useMemo, useState } from "react";
import { periodLabel, type BudgetCadence } from "@/lib/budgets";
import type { FundingTokenOption } from "@/lib/funding/display";
import { formatFundingAmount } from "@/lib/funding/display";
import {
  amountColumns, buildSchedule, readScheduleCsv, suggestDateColumn, type SchedulePeriod, type ScheduleTable,
} from "@/lib/funding/schedule";
import { Button, Field, Input, Select, Textarea } from "@/components/ui";

const NO_DATE = "none";
const SKIP = "";
const PREVIEW_ROWS = 6;

/** A token named by a column header ("signius_gvtt" → GVTT), when exactly one option's ticker appears in it. */
function guessToken(header: string, options: readonly FundingTokenOption[]): string {
  const words = header.toLowerCase().split(/[^a-z0-9]+/);
  const hits = options.filter((o) => words.includes(o.ticker.toLowerCase()));
  return hits.length === 1 ? hits[0]!.unit : SKIP;
}

function initialTokens(table: ScheduleTable, dateColumn: number | null, options: readonly FundingTokenOption[]): Record<number, string> {
  const guesses = Object.fromEntries(amountColumns(table, dateColumn).map((i) => [i, guessToken(table.headers[i]!, options)]));
  // Two columns naming the same token (yours and another community's) are left for the admin to choose.
  const counts = new Map<string, number>();
  for (const unit of Object.values(guesses)) if (unit) counts.set(unit, (counts.get(unit) ?? 0) + 1);
  return Object.fromEntries(Object.entries(guesses).map(([i, unit]) => [i, unit && counts.get(unit) === 1 ? unit : SKIP]));
}

export function ScheduleCsvImport({ cadence, options, onUse }: {
  cadence: BudgetCadence;
  options: readonly FundingTokenOption[];
  /** The periods read, and the tokens they set (whose earlier amounts they replace). */
  onUse: (periods: SchedulePeriod[], units: string[]) => void;
}) {
  const [csv, setCsv] = useState("");
  const [dateChoice, setDateChoice] = useState<string | null>(null);
  const [startMonth, setStartMonth] = useState("");
  const [tokens, setTokens] = useState<Record<number, string> | null>(null);

  const table = useMemo(() => (csv.trim() ? readScheduleCsv(csv) : null), [csv]);
  const suggested = table ? suggestDateColumn(table) : null;
  const dateColumn = dateChoice === null ? suggested : dateChoice === NO_DATE ? null : Number(dateChoice);
  const columns = table ? amountColumns(table, dateColumn) : [];
  const chosen = tokens ?? (table ? initialTokens(table, dateColumn, options) : {});
  const mapped = columns.flatMap((index) => {
    const token = options.find((o) => o.unit === chosen[index]);
    return token ? [{ index, unit: token.unit, ticker: token.ticker, decimals: token.decimals }] : [];
  });
  const built = table && table.headers.length > 0
    ? buildSchedule(table, { dateColumn, startMonth: startMonth || null, cadence, columns: mapped })
    : null;
  const issues = table && table.headers.length === 0 ? table.issues : built?.issues ?? [];

  function load(text: string) {
    setCsv(text);
    setDateChoice(null);
    setTokens(null);
  }

  return (
    <section className="space-y-3 rounded-lg border border-zinc-700 p-4">
      <h3 className="text-sm font-medium">Import from a CSV</h3>
      <p className="text-xs text-zinc-400">
        A funder&apos;s release plan: one row per period, a date column if it has one (2021-07, 2021-07-01 or 01.07.2021),
        and columns of amounts in whole units with a dot for decimals, for example{" "}
        <span className="font-mono">month,sc_allocation,ambassador_allocation</span>. You choose which columns are
        yours and which token each is paid in.
      </p>
      <input type="file" accept=".csv,text/csv" aria-label="Schedule CSV file"
        onChange={(e) => { const f = e.target.files?.[0]; if (f) void f.text().then(load); e.target.value = ""; }}
        className="block w-full text-sm text-zinc-300 file:mr-3 file:rounded-lg file:border-0 file:bg-zinc-800 file:px-3 file:py-1.5 file:text-sm file:text-zinc-100 hover:file:bg-zinc-700" />
      <Textarea aria-label="Schedule CSV text" rows={4} className="font-mono text-xs" value={csv}
        placeholder={"month,amount\n2026-01,225000\n2026-02,221625"} onChange={(e) => load(e.target.value)} />

      {table && table.headers.length > 0 && (
        <>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Date column" hint={dateColumn === null ? "The rows are consecutive periods, in file order." : undefined}>
              <Select aria-label="Date column" value={dateColumn === null ? NO_DATE : String(dateColumn)}
                onChange={(e) => { setDateChoice(e.target.value); setTokens(null); }}>
                {table.headers.map((header, i) => <option key={i} value={String(i)}>{header}</option>)}
                <option value={NO_DATE}>No date column</option>
              </Select>
            </Field>
            {dateColumn === null && (
              <Field label="First row's period">
                <Input aria-label="First row's month" type="month" value={startMonth} onChange={(e) => setStartMonth(e.target.value)} />
              </Field>
            )}
          </div>
          {columns.length > 0 && (
            <div className="space-y-2">
              <p className="text-sm">Amount columns</p>
              {columns.map((index) => (
                <div key={index} className="grid items-center gap-2 sm:grid-cols-[1fr_12rem]">
                  <span className="truncate font-mono text-xs">{table.headers[index]}</span>
                  <Select aria-label={`Token for ${table.headers[index]}`} value={chosen[index] ?? SKIP}
                    onChange={(e) => setTokens({ ...chosen, [index]: e.target.value })}>
                    <option value={SKIP}>Skip this column</option>
                    {options.map((o) => <option key={o.unit} value={o.unit}>{o.ticker}</option>)}
                  </Select>
                </div>
              ))}
            </div>
          )}
        </>
      )}

      {issues.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-sm text-amber-300">
          {issues.slice(0, 12).map((issue, i) => <li key={i}>{issue.line ? `Line ${issue.line}: ` : ""}{issue.message}</li>)}
          {issues.length > 12 && <li>…and {issues.length - 12} more.</li>}
        </ul>
      )}

      {built && built.periods.length > 0 && (
        <div className="space-y-2">
          <div className="overflow-x-auto rounded-lg border border-zinc-800">
            <table className="w-full text-left text-sm" aria-label="Import preview">
              <thead className="text-xs text-zinc-500">
                <tr>
                  <th className="px-3 py-1 font-normal">Period</th>
                  {mapped.map((m) => <th key={m.unit} className="px-3 py-1 font-normal">{m.ticker}</th>)}
                </tr>
              </thead>
              <tbody className="divide-y divide-zinc-800">
                {built.periods.slice(0, PREVIEW_ROWS).map((period) => (
                  <tr key={period.month}>
                    <td className="px-3 py-1">{periodLabel(period.month, cadence)}</td>
                    {mapped.map((m) => (
                      <td key={m.unit} className="px-3 py-1 font-mono text-xs">{period.amounts.find((a) => a.unit === m.unit)?.amount ?? "—"}</td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex flex-wrap items-center justify-between gap-2 text-sm">
            <span>
              {built.periods.length} periods, {periodLabel(built.periods[0]!.month, cadence)} –{" "}
              {periodLabel(built.periods[built.periods.length - 1]!.month, cadence)}; total{" "}
              <span className="font-mono">
                {Object.entries(built.totals).map(([unit, total]) => formatFundingAmount(unit, total, options)).join(", ")}
              </span>
            </span>
            <Button variant="secondary" disabled={issues.length > 0}
              onClick={() => { onUse(built.periods, mapped.map((m) => m.unit)); load(""); }}>
              Use these amounts
            </Button>
          </div>
        </div>
      )}
    </section>
  );
}
