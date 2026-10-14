"use client";

import { useEffect, useState } from "react";
import { ChevronLeft, ChevronRight } from "lucide-react";
import {
  BUDGET_MONTH_RE, currentBudgetMonth, currentPeriodStart, quarterStartMonth, shiftMonth,
} from "@/lib/budgets";
import type { BudgetView } from "@/lib/budgetSetups";
import { Button, Field, Input, Select } from "@/components/ui";
import { QuarterSelect } from "./QuarterSelect";

export type { BudgetView };

/** The picker's views: the worksheet's, plus the Dashboard's all-time range. */
export type PeriodPickerView = BudgetView | "all";

/**
 * `V` is the caller's own set of views: the options offered (`recurring`,
 * `allTime`) must stay within it.
 */
export function BudgetPeriodPicker<V extends PeriodPickerView = BudgetView>({
  month, view, disabled = false, recurring = true, allTime = false, onChange,
}: {
  month: string;
  view: V;
  disabled?: boolean;
  recurring?: boolean;
  /** Offer "All time": no period to pick, `month` is kept for the way back. */
  allTime?: boolean;
  onChange: (month: string, view: V) => void;
}) {
  const quarterMonth = quarterStartMonth(month);
  const selected = view === "quarter" ? quarterMonth : month;
  const year = selected.slice(0, 4);
  const [yearText, setYearText] = useState(year);
  useEffect(() => setYearText(year), [year]);
  const periodName = view === "quarter" ? "quarter" : "month";
  const today = view === "quarter" ? currentPeriodStart("quarterly") : currentBudgetMonth();

  function shift(direction: number) {
    onChange(shiftMonth(selected, direction * (view === "quarter" ? 3 : 1)), view);
  }

  return (
    <div className="flex flex-wrap items-end gap-3">
      <Field label="View">
        <Select aria-label="Budget plan" value={view} disabled={disabled}
          onChange={(event) => {
            const next = event.target.value as V;
            onChange(next === "quarter" ? quarterMonth : month, next);
          }}>
          <option value="month">Month</option>
          <option value="quarter">Quarter</option>
          {recurring && <option value="recurring">Recurring defaults</option>}
          {allTime && <option value="all">All time</option>}
        </Select>
      </Field>
      {view !== "all" && <div className="flex flex-wrap items-end gap-2">
        <Button variant="secondary" aria-label={`Previous ${periodName}`}
          disabled={disabled || selected === "1000-01"} onClick={() => shift(-1)}>
          <ChevronLeft className="h-4 w-4" />
        </Button>
        {view === "quarter" ? <>
          <Field label="Quarter">
            <QuarterSelect month={selected.slice(5)} disabled={disabled}
              onChange={(quarterMonth) => onChange(`${year}-${quarterMonth}`, view)} />
          </Field>
          <Field label="Year">
            <Input type="number" className="!w-28" min="1000" max="9999" aria-label="Budget year"
              value={yearText} disabled={disabled} onChange={(event) => setYearText(event.target.value)}
              onKeyDown={(event) => { if (event.key === "Enter") event.currentTarget.blur(); }}
              onBlur={() => {
                if (/^[1-9]\d{3}$/.test(yearText) && yearText !== year) onChange(`${yearText}-${selected.slice(5)}`, view);
                setYearText(year);
              }} />
          </Field>
        </> : <Field label="Month">
          <Input type="month" min="1000-01" max="9999-12" aria-label="Budget month"
            value={month} disabled={disabled} onChange={(event) => {
              if (BUDGET_MONTH_RE.test(event.target.value)) onChange(event.target.value, view);
            }} />
        </Field>}
        <Button variant="secondary" aria-label={`Next ${periodName}`}
          disabled={disabled || selected === (view === "quarter" ? "9999-10" : "9999-12")} onClick={() => shift(1)}>
          <ChevronRight className="h-4 w-4" />
        </Button>
        <Button variant="ghost" disabled={disabled || selected === today} onClick={() => onChange(today, view)}>
          This {periodName}
        </Button>
      </div>}
    </div>
  );
}
