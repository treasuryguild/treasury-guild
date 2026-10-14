"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";
import { Button, Input, Select } from "@/components/ui";
import { isPastPeriod, type BudgetCadence } from "@/lib/budgets";
import {
  type BudgetAmount, budgetAmountLabel, budgetAmountsText, backfillEndsOffQuarter, type BudgetMode, type BudgetSetupContext,
  type BudgetSetupDraft, earliestSetupMonth, isBackfill, nextSetupAfter, setupAt, setupLabel,
} from "@/lib/budgetSetups";

/** Native dialog supplies focus trapping and restores focus to the editor. */
export function BudgetDialog({ title, children, onClose }: { title: string; children: ReactNode; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const node = dialog.current!;
    const previous = document.activeElement as HTMLElement | null;
    node.showModal();
    return () => { node.close(); previous?.focus(); };
  }, []);
  return <dialog ref={dialog} aria-labelledby="budget-dialog-title" onCancel={(event) => { event.preventDefault(); onClose(); }}
    className="m-auto max-h-[85vh] w-[min(40rem,95vw)] overflow-y-auto rounded-2xl border border-[var(--border)] bg-[var(--option-background)] p-6 text-[var(--foreground)] shadow-xl backdrop:bg-black/60">
    <h2 id="budget-dialog-title" className="mb-4 text-lg font-semibold">{title}</h2>{children}
  </dialog>;
}

export function BudgetSetupDialog({ name, context, month, cadence, recurring, initial, onApply, onClose }: {
  name: string; context?: BudgetSetupContext; month: string; cadence: BudgetCadence; recurring: boolean;
  initial?: BudgetSetupDraft; onApply: (draft: BudgetSetupDraft) => void; onClose: () => void;
}) {
  const active = setupAt(context, month);
  const [mode, setMode] = useState<BudgetMode>(initial?.mode ?? (active?.mode === "recurring" && isPastPeriod(month, active.cadence) ? "recurring" : recurring ? "recurring" : cadence));
  const [frequency, setFrequency] = useState<BudgetCadence>(initial?.cadence ?? (recurring ? active?.cadence ?? cadence : cadence));
  const initiallySwitching = !active || mode !== active.mode || frequency !== active.cadence;
  const [start, setStart] = useState(initial?.startsOn ?? (initiallySwitching ? earliestSetupMonth(context, month, frequency) : month));
  const effectiveActive = setupAt(context, start);
  const switching = !effectiveActive || mode !== effectiveActive.mode || frequency !== effectiveActive.cadence;
  const [reason, setReason] = useState(initial?.reason ?? "");
  // Before the first setup nothing is displaced: a backfill may start in the
  // past and runs until that setup. Any other switch starts at or after the
  // current month; an edit of the existing setup is past once its period ended.
  const backfill = isBackfill(context, start);
  const until = backfill ? nextSetupAfter(context, start) : undefined;
  const past = (!switching || backfill) && isPastPeriod(start, frequency);
  const minimum = switching && !backfill ? earliestSetupMonth(context, month, frequency) : "1000-01";
  const offQuarter = backfillEndsOffQuarter(context, start, frequency);
  const boundary = frequency === "quarterly" || (switching && (effectiveActive?.cadence === "quarterly" || !effectiveActive && context?.legacy.some((b) => b.cadence === "quarterly")));
  const later = !backfill && (switching || mode === "recurring" && !past)
    ? context?.timeline.find((s) => s.starts_on > start + "-01") : undefined;
  const invalid = !/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(start) || start < minimum ||
    (boundary && !["01", "04", "07", "10"].includes(start.slice(5))) || (past && !reason.trim()) || !!later || offQuarter;
  return <BudgetDialog title={`Budget setup for ${name}`} onClose={onClose}>
    <p className="mb-4 text-sm text-zinc-400">{active ? `Currently: ${setupLabel(active)}.` : context?.legacyConflict ? "Existing budgets need review. Choose one setup going forward; the original records remain in history." : "Choose how this project will be budgeted."}</p>
    <label className="mb-4 block text-sm">Budget setup
      <Select aria-label="Project budget setup" className="mt-1" value={mode} onChange={(event) => {
        const next = event.target.value as BudgetMode;
        const nextCadence = next === "recurring" ? frequency : next;
        setMode(next); setFrequency(nextCadence);
        if (next !== active?.mode || nextCadence !== active?.cadence) setStart(earliestSetupMonth(context, month, nextCadence));
      }}>
        <option value="recurring">Recurring amount from this date onward</option>
        <option value="monthly">Monthly planning — set each month separately</option>
        <option value="quarterly">Quarterly planning — set each quarter separately</option>
      </Select>
    </label>
    {mode === "recurring" && <label className="mb-4 block text-sm">Repeat every
      <Select aria-label="Project recurring frequency" value={frequency} onChange={(event) => {
        const value = event.target.value as BudgetCadence; setFrequency(value);
        setStart(earliestSetupMonth(context, month, value));
      }}><option value="monthly">Month</option><option value="quarterly">Quarter</option></Select>
    </label>}
    <label className="mb-4 block text-sm">{switching || mode === "recurring" ? "Effective from" : "Budget period"}
      <Input className="mt-1" aria-label="Setup effective month" type="month" min={minimum} max="9999-12" value={start} onChange={(event) => setStart(event.target.value)} />
    </label>
    <p className="mb-4 text-sm text-zinc-400">{past && !switching ? "This correction applies only to the selected period. Other periods keep their amounts." : mode === "recurring" ? "This amount repeats from the effective date. Earlier amounts are preserved." : "Only the selected period receives these amounts. Use Copy previous period when planning subsequent periods."}
      {until && ` This setup runs until ${until.starts_on.slice(0, 7)}, when the existing ${setupLabel(until).toLowerCase()} setup starts.`}
      {boundary && " Changes involving quarterly budgets must start in January, April, July or October."}
      {active && active.cadence !== frequency && " Enter new amounts for the new cadence; amounts are not automatically divided or multiplied."}</p>
    {past && <label className="mb-4 block text-sm">{switching ? "Reason for setting a past budget" : "Reason for correcting a past budget"}
      <Input aria-label="Budget correction reason" maxLength={500} value={reason} onChange={(event) => setReason(event.target.value)} />
      <span className="text-xs text-zinc-500">The original values and your correction will be recorded.</span>
    </label>}
    {start < minimum && <p role="alert" className="mb-3 text-sm text-red-400">Choose {minimum} or later to preserve completed periods.</p>}
    {offQuarter && until && <p role="alert" className="mb-3 text-sm text-red-400">A quarterly budget before the first setup must end at a quarter boundary, but the first setup starts {until.starts_on.slice(0, 7)}. Choose monthly amounts instead.</p>}
    {later && <p role="alert" className="mb-3 text-sm text-amber-400">A {setupLabel(later).toLowerCase()} setup is already scheduled for {later.starts_on}. Edit that setup or choose a date after it.</p>}
    <div className="flex justify-end gap-2"><Button variant="secondary" onClick={onClose}>Cancel</Button>
      <Button disabled={invalid} onClick={() => onApply({ mode, cadence: frequency, startsOn: start, reason })}>Stage setup change</Button></div>
  </BudgetDialog>;
}

export function BudgetSetupHistory({ context }: { context: BudgetSetupContext }) {
  return <details className="w-full text-xs text-zinc-400"><summary className="cursor-pointer">Setup history &amp; scheduled changes</summary>
    <ul className="mt-2 space-y-2">
      {context.timeline.map((s, index) => <li key={s.id}>{setupLabel(s)} · {s.starts_on === "1000-01-01" ? "Imported default" : s.starts_on} → {context.timeline[index + 1]?.starts_on ?? "onward"}
        {s.amounts.map((a) => <span className="ml-2" key={a.unit}>{budgetAmountLabel(a)}</span>)}</li>)}
      {context.legacy.map((b, index) => <li key={index}>Preserved original · {b.budget_month ?? "Recurring"} · {b.cadence} · {budgetAmountLabel(b)}</li>)}
      {context.history.map((h, index) => <li key={index} className="border-t border-[var(--border)] pt-2">
        {h.changed_at} · {h.changed_by} · effective {h.effective_on}{h.reason && ` · ${h.reason}`}
        <details><summary className="cursor-pointer">View previous and saved amounts</summary>
          <div className="mt-2 space-y-2">
            {h.before_value.setup && <p>Previous setup: {setupLabel(h.before_value.setup)}</p>}
            <p>Previous repeating amounts: {amountText(h.before_value.setup?.amounts ?? [])}</p>
            {h.before_value.plans.map((p) => <p key={p.starts_on}>Previous plan · {p.starts_on}: {amountText(p.amounts)}</p>)}
            <p>Saved {setupLabel(h.after_value)}: {amountText(h.after_value.amounts)}</p>
          </div>
        </details>
      </li>)}
    </ul>
  </details>;
}

function amountText(amounts: BudgetAmount[]) {
  return budgetAmountsText(amounts, "No allocation");
}
