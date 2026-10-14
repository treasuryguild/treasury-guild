"use client";

import { useState } from "react";
import { Plus, RotateCcw, Trash2 } from "lucide-react";
import { BudgetSetupHistory } from "./BudgetSetupDialog";
import {
  setupAt, setupLabel, type BudgetOwnerType, type BudgetSetupContext, type BudgetSetupDraft, type BudgetView,
} from "@/lib/budgetSetups";
import { ADA_ASSET, type AssetDef } from "@/lib/assets";
import { budgetAssetOptions, type BudgetCadence } from "@/lib/budgets";
import { budgetRowChanged, budgetRowError, draftRowKey, type BudgetDraftRow } from "@/lib/budgetDrafts";
import type { TreasurySummary } from "@/lib/db/types";
import { useWalletAssets } from "@/hooks/useWalletAssets";
import { Badge, Button, ErrorText, Input, Select } from "@/components/ui";

/** One card of the worksheet: a workgroup's board budget, or a treasury's budget for manual payments. */
export interface BudgetOwner {
  id: string;
  name: string;
  kind: BudgetOwnerType;
  /** Workgroups only; a treasury is never archived. */
  archived_at: string | null;
  /** The wallet whose tokens the token picker offers: a workgroup's routed treasury, or the treasury itself. */
  treasury_id: string | null;
}

/** A column of the worksheet: one month in the quarter grid, else the period. */
export interface BudgetColumn { start: string; label: string }

/** One period a project is planned in, placed on the worksheet's columns. */
export interface BudgetCell {
  start: string;
  cadence: BudgetCadence;
  label: string;
  /** Index into the columns, or null when the cell spans every column. */
  column: number | null;
  /** Editing must go through the setup dialog (no setup, recurring, past period). */
  needsSetup: boolean;
  /** A quarterly project seen in the month view: read-only, edited in the quarter view. */
  quarterLink: boolean;
}

/** Grid templates keyed by column count; Tailwind needs them written out. */
export const GRID_CLASS: Record<number, string> = {
  1: "grid grid-cols-1 gap-x-4 gap-y-2 md:grid-cols-[minmax(0,1.1fr)_minmax(10rem,1fr)_minmax(8rem,.9fr)]",
  3: "grid grid-cols-1 gap-x-4 gap-y-2 md:grid-cols-[minmax(0,1fr)_repeat(3,minmax(7rem,1fr))_minmax(7rem,.7fr)]",
};
const SPAN_CLASS: Record<number, string> = { 1: "", 3: "md:col-span-3" };
const INNER_CLASS: Record<number, string> = { 1: "grid grid-cols-1 gap-x-4 gap-y-2", 3: "grid grid-cols-1 gap-x-4 gap-y-2 md:grid-cols-3" };
const COLUMN_START = ["md:col-start-1", "md:col-start-2", "md:col-start-3"];

export function blankRow(asset: AssetDef, cell: Pick<BudgetCell, "start" | "cadence">): BudgetDraftRow {
  return {
    key: draftRowKey(asset.unit, cell.start), asset, month: cell.start, amount: "", cadence: cell.cadence,
    original: null, persisted: false, removed: false, copied: false, source: null,
  };
}

export function BudgetProjectCard({ owner: group, view, columns, cells, fallback, rows, frequency, canEdit, disabled, assets,
  treasury, error, showValidation, onChange, context, config, referenceMonth, onSetup, onReset, onClearBudgets, onOpenQuarter }: {
  owner: BudgetOwner;
  view: BudgetView;
  columns: BudgetColumn[];
  cells: BudgetCell[];
  /** Where a first token lands when the project has no period yet. */
  fallback: Pick<BudgetCell, "start" | "cadence">;
  rows: BudgetDraftRow[];
  frequency: string;
  canEdit: boolean;
  disabled: boolean;
  assets: AssetDef[];
  treasury?: TreasurySummary;
  error?: string;
  showValidation: boolean;
  context?: BudgetSetupContext;
  config?: BudgetSetupDraft;
  referenceMonth: string;
  onChange: (rows: BudgetDraftRow[]) => void;
  /** Open the setup dialog, for a cell or for the project as a whole. */
  onSetup: (cell?: BudgetCell) => void;
  onReset: () => void;
  onClearBudgets?: () => void;
  onOpenQuarter?: (month: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [touched, setTouched] = useState<Set<string>>(new Set());
  const wallet = useWalletAssets(adding ? treasury?.address : undefined);
  const options = budgetAssetOptions([...assets, ...rows.map((row) => row.asset)], wallet.data?.tokens ?? [])
    .filter((asset) => !rows.some((row) => row.asset.unit === asset.unit));
  const active = setupAt(context, referenceMonth);
  const editable = cells.filter((cell) => !cell.needsSetup && !cell.quarterLink);
  const groupChanged = !!config || rows.some(budgetRowChanged);
  const count = columns.length;
  const dated = view !== "recurring";
  const units = [...new Set(rows.map((row) => row.asset.unit))]
    .filter((unit) => frequency === "all" || rows.some((row) => row.asset.unit === unit && (row.cadence === frequency || budgetRowChanged(row))));
  const canAdd = canEdit && (rows.length === 0 || editable.length > 0 || !!config) &&
    new Set(rows.filter((row) => !row.removed).map((row) => row.asset.unit)).size < 50;

  function rowAt(asset: AssetDef, cell: BudgetCell): BudgetDraftRow {
    return rows.find((row) => row.key === draftRowKey(asset.unit, cell.start)) ?? blankRow(asset, cell);
  }

  function update(row: BudgetDraftRow, change: Partial<BudgetDraftRow>) {
    const next = { ...row, ...change };
    onChange(rows.some((item) => item.key === row.key)
      ? rows.map((item) => item.key === row.key ? next : item) : [...rows, next]);
  }

  /** The worksheet routes a project with no editable cell to the setup dialog. */
  function add(asset: AssetDef) {
    setAdding(false);
    const cell = editable[0] ?? cells[0] ?? fallback;
    onChange([...rows, blankRow(asset, cell)]);
    requestAnimationFrame(() => document.getElementById(`amount-${group.id}-${asset.unit}-${cell.start}`)?.focus());
  }

  function removeToken(unit: string) {
    onChange(rows.flatMap((row) => row.asset.unit !== unit ? [row] : row.original ? [{ ...row, removed: true }] : []));
  }

  function undoToken(unit: string) {
    onChange(rows.flatMap((row) => row.asset.unit !== unit ? [row]
      : row.original ? [{ ...row, ...row.original, removed: false, copied: false }] : []));
  }

  const setupBadge = config ? setupLabel(config) + " from " + config.startsOn
    : active ? setupLabel(active) : context?.legacyConflict ? "Needs review" : "No setup";
  const quarterCell = cells.find((cell) => cell.quarterLink);

  return (
    <div role="rowgroup" aria-label={group.name} className="overflow-clip rounded-2xl border border-[var(--border)] bg-[var(--surface)]">
      <div role="row" className="flex flex-wrap items-center gap-2 border-b border-[var(--border)] bg-[var(--surface-inset)] px-5 py-3">
        <div role="rowheader" className="flex flex-wrap items-center gap-2">
          <h3 className="text-base font-semibold">{group.name}{group.archived_at ? " (Archived)" : ""}</h3>
          {group.kind === "treasury" && <Badge tone="blue">Treasury</Badge>}
          <Badge tone={config ? "blue" : "default"}>{setupBadge}</Badge>
          {groupChanged && <Badge tone="yellow">Unsaved</Badge>}
          {!canEdit && <span className="text-xs text-zinc-500">View only</span>}
        </div>
        {canEdit && <div className="flex flex-wrap items-center gap-1 sm:ml-auto">
          <Button variant="ghost" className="!min-h-8 !px-2 !py-1 text-xs" disabled={disabled} onClick={() => onSetup()}>Change setup</Button>
          {config && <Button variant="ghost" className="!min-h-8 !px-2 !py-1 text-xs" disabled={disabled} onClick={onReset}>Undo setup change</Button>}
          {onClearBudgets && context && (context.timeline.length > 0 || context.legacyConflict || context.history.length > 0) &&
            <Button variant="ghost" className="!min-h-8 !px-2 !py-1 text-xs" disabled={disabled || groupChanged} onClick={onClearBudgets}
              title={groupChanged ? "Save or discard this project's changes before resetting budgets" : undefined}
              aria-label={`Reset budgets for ${group.name}`}>Reset budgets</Button>}
        </div>}
      </div>
      {context && (context.timeline.length > 0 || context.legacyConflict) &&
        <div className="border-b border-[var(--border)] px-5 py-2"><BudgetSetupHistory context={context} /></div>}

      {units.map((unit) => {
        const asset = rows.find((row) => row.asset.unit === unit)!.asset;
        const tokenRows = rows.filter((row) => row.asset.unit === unit);
        const changed = tokenRows.some(budgetRowChanged);
        const removed = tokenRows.length > 0 && tokenRows.every((row) => row.removed);
        const inherited = tokenRows.every((row) => !row.persisted && row.original !== null);
        const canRemove = tokenRows.some((row) => !row.removed && (row.persisted || !row.original || config));
        return (
          <div role="row" key={unit} className={`${GRID_CLASS[count]} items-start border-b border-[var(--border)] px-5 py-3 last:border-b-0 ${changed ? "bg-[var(--accent-soft)]" : ""}`}>
            <div role="cell" className={removed ? "opacity-50 line-through" : ""}>
              <p className="text-sm font-medium">{asset.fieldName}</p>
              {dated && <p className="mt-1 text-xs text-zinc-500">
                {inherited ? "Recurring default" : tokenRows.some((row) => row.persisted) ? "Saved allocation" : "New allocation"}
                {count > 1 && (tokenRows[0]!.cadence === "quarterly" ? " · one amount per quarter" : " · one amount per month")}
              </p>}
            </div>
            <div role="cell" className={`${SPAN_CLASS[count]} ${INNER_CLASS[count]}`}>
              {cells.map((cell) => {
                const row = rowAt(asset, cell);
                const validation = showValidation || touched.has(row.key) ? budgetRowError(row, dated, row.cadence) : null;
                const id = `amount-${group.id}-${unit}-${cell.start}`;
                const rowChanged = budgetRowChanged(row);
                const cellInherited = !row.persisted && row.original !== null;
                const locksInput = cell.needsSetup && !config;
                const placement = cell.column === null ? SPAN_CLASS[count] : COLUMN_START[cell.column];
                const spanning = cell.column === null && count > 1;
                // A single-column view keeps the plain label; the grid names the month.
                const label = count > 1 ? `${group.name} ${asset.fieldName} ${cell.label} budget amount` : `${group.name} ${asset.fieldName} budget amount`;
                // A cell shown under a column header for a different month names its own period.
                const offColumn = cell.column !== null && columns[cell.column]?.start !== cell.start;
                const caption = spanning ? `${cell.label} · whole quarter` : cell.label;
                if (cell.quarterLink) {
                  return <div key={cell.start} className={placement}>
                    <p className="text-sm font-mono tabular-nums">{row.original ? `${row.original.amount} ${asset.fieldName}` : "No allocation"}</p>
                    <p className="mt-1 text-xs text-zinc-500">{cell.label} ·{" "}
                      <button type="button" className="text-indigo-400 hover:underline" disabled={disabled}
                        onClick={() => onOpenQuarter?.(cell.start)}>Edit in {cell.label}</button></p>
                  </div>;
                }
                return <div key={cell.start} className={placement}>
                  {count > 1 && <span className="mb-1 block text-xs font-medium text-zinc-400">{caption}</span>}
                  <Input id={id} data-budget-amount inputMode="decimal" className="text-right font-mono tabular-nums"
                    aria-label={label} aria-invalid={validation ? true : undefined} aria-describedby={`${id}-hint`}
                    disabled={disabled || !canEdit || (row.removed && row.amount !== "")} value={row.amount} placeholder={row.removed ? "None" : "0.00"}
                    readOnly={locksInput}
                    onClick={() => { if (locksInput) onSetup(cell); }}
                    onKeyDown={(event) => {
                      if (locksInput && (event.key === "Enter" || event.key === "Backspace" || event.key.length === 1)) {
                        event.preventDefault(); event.stopPropagation(); onSetup(cell);
                      }
                    }}
                    onChange={(event) => {
                      const amount = event.target.value;
                      // Clearing a saved cell stages its removal for that period only.
                      update(row, { amount, removed: amount.trim() === "" && !!row.original });
                    }}
                    onBlur={() => setTouched((current) => new Set(current).add(row.key))} />
                  <p id={`${id}-hint`} className={`mt-1 text-xs ${validation ? "text-red-400" : "text-zinc-500"}`}>
                    {validation || (row.removed ? "Will be removed when saved" : rowChanged && row.original
                      ? `Was ${row.original.amount} ${asset.fieldName}` : offColumn ? cell.label
                        : cellInherited ? "Repeating amount" : row.persisted ? "Saved" : rowChanged ? "New" : "Not set")}
                  </p>
                </div>;
              })}
            </div>
            <div role="cell" className="flex flex-wrap items-center justify-end gap-1 md:justify-start">
              {changed && <Badge tone="yellow">{removed ? "Remove" : tokenRows.some((row) => row.copied) ? "Copied" : "Changed"}</Badge>}
              {canEdit && changed && <Button variant="ghost" className="!min-h-8 !p-1.5"
                aria-label={`Undo ${group.name} ${asset.fieldName} change`} disabled={disabled}
                onClick={() => undoToken(unit)}><RotateCcw className="h-3.5 w-3.5" /></Button>}
              {canEdit && !removed && canRemove && !cells.every((cell) => cell.quarterLink) && <Button variant="ghost"
                className="!min-h-8 !p-1.5" aria-label={`Remove ${group.name} ${asset.fieldName} budget`} disabled={disabled}
                onClick={() => removeToken(unit)}>
                <Trash2 className="h-3.5 w-3.5" />
              </Button>}
              {!changed && inherited && <span className="text-xs text-zinc-500">
                {canEdit ? "Repeating amount" : "Using recurring amount"}
              </span>}
            </div>
          </div>
        );
      })}
      {rows.length === 0 && <p className="px-5 py-4 text-sm text-zinc-500">
        {quarterCell ? <>No {quarterCell.label} allocation yet.{canEdit && onOpenQuarter && <>{" "}
          <button type="button" className="text-indigo-400 hover:underline" disabled={disabled}
            onClick={() => onOpenQuarter(quarterCell.start)}>Plan it in the quarter view</button>.</>}</>
          : context?.legacyConflict && !active ? "Review the preserved original budgets and choose a setup going forward."
            : !active && !config ? (group.kind === "treasury"
              ? "No setup yet. Add a budget for manual payments made from this treasury."
              : "No setup yet. Add a budget to choose how this project is planned.")
              : "No allocation for this period. Add an amount to include this project in your plan."}
      </p>}
      <ErrorText error={error} className="px-5 py-2" />

      {canAdd && <div className="flex flex-wrap items-center gap-2 border-t border-dashed border-[var(--border)] px-5 py-2">
        <Button variant="ghost" className="!min-h-8 !px-2 !py-1 text-xs" disabled={disabled} onClick={() => {
          if (rows.length === 0) add(ADA_ASSET); else setAdding((value) => !value);
        }}><Plus className="h-3.5 w-3.5" />{rows.length ? "Add token" : "Add budget"}</Button>
        {adding && <>
          <Select className="sm:!w-64" aria-label={`Add token for ${group.name}`} value="" disabled={disabled}
            onChange={(event) => { const asset = options.find((option) => option.unit === event.target.value); if (asset) add(asset); }}>
            <option value="">Choose a token…</option>
            {options.map((asset) => <option key={asset.unit} value={asset.unit}>{asset.fieldName}</option>)}
          </Select>
          <Button variant="ghost" className="!min-h-8 !px-2 !py-1 text-xs" disabled={disabled} onClick={() => setAdding(false)}>Cancel</Button>
          <span className="text-xs text-zinc-500">{wallet.loading ? "Loading treasury tokens…"
            : group.kind === "treasury" ? "Registry and this treasury's tokens" : "Registry and assigned treasury tokens"}</span>
          <ErrorText error={wallet.error} />
        </>}
      </div>}
    </div>
  );
}
