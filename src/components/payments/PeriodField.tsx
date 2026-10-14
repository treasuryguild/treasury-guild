"use client";

import { budgetPeriod, currentBudgetMonth, BUDGET_MONTH_RE, monthDate } from "@/lib/budgets";
import { taskBudgetPeriod, type BudgetSetup } from "@/lib/budgetSetups";
import { Field, Input } from "@/components/ui";

/**
 * The budget month a payment counts against. The hint names the period the
 * treasury's setup resolves it to (its quarter when the treasury budgets by
 * quarter), the same way the task dialog does.
 */
export function PeriodField({ month, setups, disabled, onChange }: {
  month: string;
  setups: readonly Pick<BudgetSetup, "starts_on" | "cadence">[];
  disabled: boolean;
  onChange: (month: string) => void;
}) {
  const valid = BUDGET_MONTH_RE.test(month);
  const period = valid ? taskBudgetPeriod(`${month}-01`, setups, currentBudgetMonth()) : null;
  const quarterly = period !== null && period.code.includes("Q");
  const label = period ? budgetPeriod(quarterly ? "quarterly" : "monthly", monthDate(period.month)).label : null;
  return (
    <Field label="Budget period" hint={
      !valid ? "Choose a month."
        : quarterly ? `Counts against ${label} (${period!.code}): this treasury budgets by quarter.`
          : setups.length === 0 ? `Counts against ${label}. This treasury has no budget yet; the spend is still recorded for it.`
            : `Counts against ${label}.`
    }>
      <Input type="month" aria-label="Budget month" value={month} disabled={disabled} className="!w-auto"
        onChange={(event) => onChange(event.target.value)} />
    </Field>
  );
}
