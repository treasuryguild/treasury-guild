"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { BudgetDialog, BudgetSetupDialog } from "./BudgetSetupDialog";
import { BudgetResetDialog } from "./BudgetResetDialog";
import {
  BudgetProjectCard, GRID_CLASS, blankRow, type BudgetCell, type BudgetColumn, type BudgetOwner,
} from "./BudgetProjectCard";
import {
  budgetAmountsText,
  budgetPeriodsAt,
  type BudgetSetupContext,
  type BudgetSetupDraft,
  type BudgetView,
  contextForOwner,
  nextSetupAfter,
  setupAt,
  setupLabel,
} from "@/lib/budgetSetups";
import { Copy, Save, Search } from "lucide-react";
import { apiFetch, describeApiError } from "@/lib/api/client";
import type { BudgetsResponse, BudgetSummary } from "@/lib/api/types";
import type { AssetDef } from "@/lib/assets";
import {
  alignBudgetMonth, budgetPeriod, currentBudgetMonth, isPastPeriod, monthDate, periodLabel, quarterMonths, shiftMonth,
  shortMonthLabel, type BudgetCadence,
} from "@/lib/budgets";
import {
  acceptBudgetDraft, budgetDraftRows, budgetRowBlank, budgetRowChanged,
  budgetRowError, budgetSaveBodies, copyPeriodBudgets, draftRowKey, type BudgetDraftRow,
} from "@/lib/budgetDrafts";
import type { CreateProposalResponse } from "@/lib/api/types";
import { ProposalKind } from "@/lib/constants";
import type { TreasurySummary } from "@/lib/db/types";
import { plural } from "@/lib/format";
import type { GovernanceSettings } from "@/lib/governance/rules";
import { mayPropose } from "@/lib/roles";
import type { WorkgroupSummary } from "@/hooks/useWorkgroups";
import { Button, EmptyState, ErrorText, Input, Select } from "@/components/ui";
import { ProposeBudgetDialog, type BudgetProposalText } from "./ProposeBudgetDialog";

/** Budget consent is on: changes are proposed to a vote instead of saved. */
export interface BudgetConsent {
  settings: GovernanceSettings;
  /** Owner id → its open budget proposal, which locks the owner's budgets. */
  openProposals: Map<string, { id: string; number: number }>;
  proposalHref: (proposalId: string) => string;
  onProposed: (proposal: CreateProposalResponse) => void;
}

interface Props {
  communityId: string;
  /** Period start of the view ("YYYY-MM"; the quarter's first month in the quarter view), null for recurring defaults. */
  month: string | null;
  view: BudgetView;
  title: string;
  budgets: BudgetSummary[];
  setups: BudgetSetupContext[];
  selectedMonth?: string;
  workgroups: WorkgroupSummary[];
  /** Also budget owners in their own right: each treasury budgets the manual payments made from it (admins edit). */
  treasuries: TreasurySummary[];
  assets: AssetDef[];
  isAdmin: boolean;
  ledWorkgroupIds: Set<string>;
  onDirtyChange: (dirty: boolean) => void;
  onBusyChange: (busy: boolean) => void;
  onRefresh: () => Promise<void>;
  /** Switch to the quarter view at `month` (a quarterly project seen from the month view). */
  onOpenQuarter?: (month: string) => void;
  consent?: BudgetConsent;
}


export function BudgetWorksheet({ communityId, month, view, title, budgets, workgroups,
  treasuries, assets, isAdmin, ledWorkgroupIds, onDirtyChange, onBusyChange, onRefresh,
  setups, selectedMonth, onOpenQuarter, consent }: Props) {
  const periodCadence: BudgetCadence = view === "quarter" ? "quarterly" : "monthly";
  const referenceMonth = month ?? selectedMonth ?? currentBudgetMonth();
  const columns: BudgetColumn[] = view === "quarter" ? quarterMonths(referenceMonth).map((start) => ({ start, label: shortMonthLabel(start) }))
    : [{ start: referenceMonth, label: month ? title : "Amount" }];
  const fallback = { start: alignBudgetMonth(referenceMonth, periodCadence), cadence: periodCadence };
  const [setupDrafts, setSetupDrafts] = useState<Record<string, BudgetSetupDraft>>({});
  const [revisions, setRevisions] = useState<Record<string, number>>({});
  const [setupPrompt, setSetupPrompt] = useState<{ id: string; rows: BudgetDraftRow[]; month: string; cadence: BudgetCadence } | null>(null);
  const [review, setReview] = useState(false);
  const [resetPrompt, setResetPrompt] = useState<{ id: string; revision: number } | null>(null);
  const [resetContexts, setResetContexts] = useState<Record<string, BudgetSetupContext>>({});
  // Workgroups first, then treasuries, as the workspace lists them.
  const owners: BudgetOwner[] = [
    ...workgroups.map((group): BudgetOwner => ({
      id: group.id, name: group.name, kind: "workgroup", archived_at: group.archived_at, treasury_id: group.treasury_id,
    })),
    ...treasuries.map((treasury): BudgetOwner => ({
      id: treasury.id, name: treasury.name, kind: "treasury", archived_at: treasury.archived_at, treasury_id: treasury.id,
    })),
  ];
  const ownerFor = (id: string) => owners.find((owner) => owner.id === id);
  const contextFor = (id: string) => resetContexts[id] ?? contextForOwner(setups, id);
  const activeFor = (id: string) => setupAt(contextFor(id), referenceMonth);
  const configFor = (id: string): BudgetSetupDraft => setupDrafts[id] ?? {
    mode: activeFor(id)?.mode ?? (month ? periodCadence : "recurring"),
    cadence: activeFor(id)?.cadence ?? periodCadence, startsOn: referenceMonth, reason: "",
  };
  const [drafts, setDrafts] = useState<Record<string, BudgetDraftRow[]>>({});
  const [accepted, setAccepted] = useState<Record<string, BudgetDraftRow[]>>({});
  const [query, setQuery] = useState("");
  const [changesOnly, setChangesOnly] = useState(false);
  const [frequency, setFrequency] = useState("all");
  const [busy, setBusy] = useState(false);
  const [copying, setCopying] = useState(false);
  const [progress, setProgress] = useState("");
  const [notice, setNotice] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [error, setError] = useState<string | null>(null);
  const [showValidation, setShowValidation] = useState(false);
  const table = useRef<HTMLDivElement>(null);
  const working = busy || copying;
  const [proposing, setProposing] = useState(false);
  const [proposalError, setProposalError] = useState<string | null>(null);
  const canEdit = (id: string) => {
    const owner = ownerFor(id);
    if (!owner || owner.archived_at) return false;
    // Under budget consent: whoever may propose, while no proposal holds the budget.
    if (consent) {
      return !consent.openProposals.has(id) &&
        mayPropose({ isAdmin, ledWorkgroupIds }, consent.settings.proposers, owner.kind === "workgroup" ? [id] : []);
    }
    return isAdmin || (owner.kind === "workgroup" && ledWorkgroupIds.has(id));
  };
  /** The request body key naming the owner: the API accepts one or the other. */
  const ownerBody = (id: string) => ownerFor(id)?.kind === "treasury" ? { treasuryId: id } : { workgroupId: id };

  /** The period cells a staged setup plans in, placed on the current columns. */
  function configCells(config: BudgetSetupDraft): BudgetCell[] {
    const starts = config.mode === "recurring" || view !== "quarter" || config.cadence === "quarterly"
      ? [config.mode === "recurring" ? config.startsOn : alignBudgetMonth(config.startsOn, config.cadence)]
      : quarterMonths(referenceMonth).filter((m) => m >= config.startsOn);
    return (starts.length ? starts : [config.startsOn]).map((start) => placeCell(start, config.cadence, false, false));
  }

  function placeCell(start: string, cadence: BudgetCadence, needsSetup: boolean, quarterLink: boolean): BudgetCell {
    const index = columns.findIndex((column) => column.start === start);
    const column = columns.length === 1 ? 0 : cadence === "quarterly" || index < 0 ? null : index;
    return { start, cadence, label: periodLabel(start, cadence), column, needsSetup, quarterLink };
  }

  const cellsFor = (id: string): BudgetCell[] => {
    const config = setupDrafts[id];
    if (config) return configCells(config);
    return budgetPeriodsAt(contextFor(id), referenceMonth, view).map((period) => placeCell(
      period.start, period.cadence,
      period.setup.mode === "recurring" || isPastPeriod(period.start, period.cadence),
      view === "month" && period.cadence === "quarterly",
    ));
  };
  const editableCells = (id: string) => cellsFor(id).filter((cell) => !cell.needsSetup && !cell.quarterLink);

  const baselineFor = (id: string): BudgetDraftRow[] => {
    const own = budgets.filter((budget) => budget.ownerId === id);
    if (view === "recurring") return budgetDraftRows(own, null, periodCadence, referenceMonth);
    return budgetPeriodsAt(contextFor(id), referenceMonth, view).flatMap((period) => budgetDraftRows(
      own.filter((budget) => budget.cadence === period.cadence && budget.periodStart.slice(0, 7) === period.start),
      period.start, period.cadence,
    ));
  };
  const rowsFor = (id: string) => drafts[id] ?? accepted[id] ?? baselineFor(id);
  const changed = owners.filter((group) => canEdit(group.id) && (setupDrafts[group.id] || rowsFor(group.id).some(budgetRowChanged)));
  const pending = changed;
  const visible = owners.filter((group) =>
    group.name.toLowerCase().includes(query.trim().toLowerCase()) &&
    (!changesOnly || setupDrafts[group.id] || rowsFor(group.id).some(budgetRowChanged)) &&
    (frequency === "all" || rowsFor(group.id).some((row) => row.cadence === frequency || budgetRowChanged(row))),
  );
  const hiddenChanges = pending.filter((group) => !visible.some((item) => item.id === group.id)).length;
  const dirty = changed.length > 0;
  const periodWord = periodCadence === "quarterly" ? "quarter" : "month";
  const previousShift = periodCadence === "quarterly" ? -3 : -1;
  const previousMonth = month ? shiftMonth(month, previousShift) : null;
  const previousLabel = previousMonth ? budgetPeriod(periodCadence, monthDate(previousMonth)).label : "";

  useEffect(() => { onDirtyChange(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => { onBusyChange(working); }, [working, onBusyChange]);
  useEffect(() => {
    if (!dirty && !working) return;
    const beforeUnload = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    const beforeLink = (event: MouseEvent) => {
      const anchor = (event.target as Element).closest?.("a[href]");
      if (!anchor || event.defaultPrevented) return;
      if (working || !window.confirm("Discard unsaved budget changes before leaving?")) {
        event.preventDefault();
        event.stopPropagation();
      }
    };
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("click", beforeLink, true);
    return () => {
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("click", beforeLink, true);
    };
  }, [dirty, working]);

  function promptSetup(id: string, rows: BudgetDraftRow[], cell?: BudgetCell) {
    setSetupPrompt({
      id, rows,
      month: cell && !cell.quarterLink ? cell.start : referenceMonth,
      cadence: cell && !cell.quarterLink ? cell.cadence : periodCadence,
    });
  }

  function updateGroup(id: string, rows: BudgetDraftRow[]) {
    if (!setupDrafts[id] && editableCells(id).length === 0) {
      promptSetup(id, rows);
      return;
    }
    stageRows(id, rows);
  }

  function stageRows(id: string, rows: BudgetDraftRow[]) {
    setRevisions((current) => ({ ...current, [id]: current[id] ?? contextFor(id)?.revision ?? 0 }));
    setDrafts((current) => ({ ...current, [id]: rows }));
    setErrors((current) => { const next = { ...current }; delete next[id]; return next; });
    setNotice("");
  }

  /** Re-key a project's rows onto the cells of a newly staged setup. */
  function applySetup(id: string, rows: BudgetDraftRow[], config: BudgetSetupDraft) {
    const active = activeFor(id);
    const cells = configCells(config);
    const first = cells[0]!;
    let next: BudgetDraftRow[];
    if (active && active.cadence !== config.cadence) {
      // Amounts are not converted between cadences: start the new cells blank.
      const units = [...new Set(rows.map((row) => row.asset.unit))];
      next = units.map((unit) => blankRow(rows.find((row) => row.asset.unit === unit)!.asset, first));
    } else {
      next = rows.map((row) => {
        const target = cells.some((cell) => cell.start === row.month) ? row.month : first.start;
        return { ...row, cadence: config.cadence, copied: true, month: target, key: draftRowKey(row.asset.unit, target) };
      }).filter((row, index, all) => all.findIndex((item) => item.key === row.key) === index);
    }
    setSetupDrafts((current) => ({ ...current, [id]: config }));
    stageRows(id, next);
  }

  async function copyPrevious() {
    if (!previousMonth || working) return;
    setCopying(true);
    setError(null);
    try {
      const result = await apiFetch<BudgetsResponse>("/api/budgets", {
        query: { communityId, month: previousMonth, view },
      });
      const updates: Record<string, BudgetDraftRow[]> = {};
      let count = 0;
      for (const group of visible.filter((item) => canEdit(item.id))) {
        const cells = editableCells(group.id);
        if (cells.length === 0) continue;
        const current = rowsFor(group.id);
        const source = result.budgets.filter((item) => item.ownerId === group.id);
        let copied = current;
        for (const cell of cells) {
          copied = copyPeriodBudgets(copied, source, cell.cadence, cell.start, shiftMonth(cell.start, previousShift));
        }
        if (new Set(copied.filter((row) => !row.removed).map((row) => row.asset.unit)).size > 50) {
          throw new Error(`${group.name} would exceed the 50-token limit. Copy a smaller selection.`);
        }
        count += copied.filter((row) => row.copied).length - current.filter((row) => row.copied).length;
        updates[group.id] = copied;
      }
      setRevisions((current) => ({ ...Object.fromEntries(Object.keys(updates).map((id) => [id, contextFor(id)?.revision ?? 0])), ...current }));
      setDrafts((current) => ({ ...current, ...updates }));
      setNotice(count > 0
        ? `${plural(count, "amount")} copied from ${previousLabel}. Review the highlighted rows, then save. Existing budgets and edits were kept.`
        : `No missing amounts to copy from ${previousLabel}. Existing allocations and edits are kept.`);
    } catch (err) {
      setError(describeApiError(err, `Could not copy last ${periodWord}'s budgets`));
    } finally { setCopying(false); }
  }

  /** The plan periods to send for a project, in order: one per changed month, the staged setup's start first. */
  function saveGroups(id: string): { month: string; rows: BudgetDraftRow[]; mode: BudgetSetupDraft["mode"]; cadence: BudgetCadence }[] {
    const rows = rowsFor(id);
    const staged = setupDrafts[id];
    if (staged?.mode === "recurring") return [{ month: staged.startsOn, rows, mode: "recurring", cadence: staged.cadence }];
    const months = new Set(rows.filter(budgetRowChanged).map((row) => row.month));
    if (staged) months.add(alignBudgetMonth(staged.startsOn, staged.cadence));
    return [...months].sort().map((m) => {
      const monthRows = rows.filter((row) => row.month === m);
      const setup = staged ?? setupAt(contextFor(id), m);
      const cadence = staged?.cadence ?? monthRows[0]?.cadence ?? setup?.cadence ?? periodCadence;
      return { month: m, rows: monthRows, mode: staged?.mode ?? setup?.mode ?? cadence, cadence };
    });
  }

  function blankTokenError(id: string): string | null {
    const rows = rowsFor(id);
    const units = [...new Set(rows.map((row) => row.asset.unit))];
    const empty = units.find((unit) => rows.filter((row) => row.asset.unit === unit).every(budgetRowBlank));
    return empty ? `Enter an amount for ${rows.find((row) => row.asset.unit === empty)!.asset.fieldName} in at least one period, or remove it.` : null;
  }

  async function saveAll(confirmed = false) {
    if (working || pending.length === 0) return;
    setShowValidation(true);
    const blanks = Object.fromEntries(pending.map((group) => [group.id, blankTokenError(group.id)]).filter(([, message]) => message));
    if (pending.some((group) => rowsFor(group.id).some((row) => budgetRowError(row, !!month, row.cadence))) || Object.keys(blanks).length) {
      setError("Fix the highlighted amounts before saving. Your edits are still here.");
      setErrors((current) => ({ ...current, ...blanks }));
      setChangesOnly(false);
      setQuery("");
      setFrequency("all");
      requestAnimationFrame(() => table.current?.querySelector<HTMLInputElement>('[aria-invalid="true"]')?.focus());
      return;
    }
    if (consent) { setProposalError(null); setProposing(true); return; }
    if (!confirmed && pending.some((g) => setupDrafts[g.id])) { setReview(true); return; }
    setReview(false);
    setBusy(true);
    setError(null);
    setErrors({});
    setNotice("");
    const succeeded: string[] = [];
    const partial: Record<string, string[]> = {};
    const failures: Record<string, string> = {};
    let completed = 0;
    // Bound concurrency while allowing many independent projects to save quickly.
    for (let start = 0; start < pending.length; start += 4) {
      await Promise.all(pending.slice(start, start + 4).map(async (group) => {
        const plans = saveGroups(group.id);
        const saved: string[] = [];
        let revision = revisions[group.id] ?? contextFor(group.id)?.revision ?? 0;
        try {
          // A monthly project in the quarter grid saves each month as its own plan,
          // chained on the revision the previous save returned.
          const bodies = budgetSaveBodies(ownerBody(group.id), plans, configFor(group.id), !!setupDrafts[group.id]);
          for (const [index, body] of bodies.entries()) {
            const result = await apiFetch<{ revision: number }>("/api/budgets", { body: { ...body, expectedRevision: revision } });
            revision = result.revision;
            saved.push(plans[index]!.month);
            setRevisions((current) => ({ ...current, [group.id]: result.revision }));
          }
          succeeded.push(group.id);
        } catch (err) {
          failures[group.id] = describeApiError(err, "Could not save this project");
          if (saved.length) partial[group.id] = saved;
        } finally {
          completed += 1;
          setProgress(`Saving ${completed} of ${pending.length} projects…`);
        }
      }));
    }
    setAccepted((current) => {
      const next = { ...current };
      for (const id of succeeded) next[id] = acceptBudgetDraft(rowsFor(id), !!month, configFor(id).cadence);
      return next;
    });
    setDrafts((current) => {
      const next = { ...current };
      for (const id of succeeded) delete next[id];
      // Months that did save stay clean; the rest of the project keeps its edits for retry.
      for (const [id, months] of Object.entries(partial)) {
        const rows = rowsFor(id);
        next[id] = [
          ...acceptBudgetDraft(rows.filter((row) => months.includes(row.month)), !!month, configFor(id).cadence),
          ...rows.filter((row) => !months.includes(row.month)),
        ];
      }
      return next;
    });
    setSetupDrafts((current) => {
      const next = { ...current };
      for (const id of [...succeeded, ...Object.keys(partial)]) delete next[id];
      return next;
    });
    setErrors(failures);
    try {
      if (succeeded.length) {
        await onRefresh();
        setResetContexts((current) => {
          const next = { ...current }; for (const id of succeeded) delete next[id]; return next;
        });
        setAccepted((current) => {
          const next = { ...current };
          for (const id of succeeded) delete next[id];
          return next;
        });
      }
    } catch {
      setError("Your successful saves are stored, but the latest balances could not be refreshed. Reload after finishing your remaining edits.");
    }
    const failed = Object.keys(failures).length;
    setNotice(failed
      ? `${succeeded.length} projects saved; ${failed} could not be saved. Their edits are kept below. Save again to retry only the remaining changes.`
      : `Saved changes for ${plural(succeeded.length, "project")}.`);
    setBusy(false);
    setProgress("");
  }

  /** Budget consent: every pending project's saves as one proposal, each against the revision it was edited from. */
  async function proposeAll(text: BudgetProposalText) {
    if (!consent || working) return;
    setBusy(true);
    setProposalError(null);
    try {
      const saves = pending.flatMap((group) => {
        const base = revisions[group.id] ?? contextFor(group.id)?.revision ?? 0;
        return budgetSaveBodies(ownerBody(group.id), saveGroups(group.id), configFor(group.id), !!setupDrafts[group.id])
          .map((body) => ({ ...body, expectedRevision: base }));
      });
      const proposal = await apiFetch<CreateProposalResponse>("/api/proposals", {
        body: { kind: ProposalKind.Budget, communityId, ...text, saves },
      });
      setProposing(false);
      setDrafts({}); setSetupDrafts({}); setRevisions({}); setErrors({}); setError(null); setShowValidation(false);
      setNotice(`Proposal #${proposal.number} is open. These budgets change when it passes.`);
      consent.onProposed(proposal);
    } catch (err) {
      setProposalError(describeApiError(err, "Could not make the proposal"));
    } finally {
      setBusy(false);
    }
  }

  const lockedOwners = consent ? owners.filter((owner) => consent.openProposals.has(owner.id)) : [];
  const gridClass = GRID_CLASS[columns.length]!;

  return (
    <div>
      {resetPrompt && <BudgetResetDialog workgroupId={resetPrompt.id}
        name={ownerFor(resetPrompt.id)!.name} expectedRevision={resetPrompt.revision}
        onClose={() => setResetPrompt(null)} onReset={async (revision) => {
          const id = resetPrompt.id;
          const context = contextFor(id)!;
          setBusy(true); setResetPrompt(null); setError(null);
          setRevisions((current) => ({ ...current, [id]: revision }));
          setAccepted((current) => ({ ...current, [id]: [] }));
          setDrafts((current) => { const next = { ...current }; delete next[id]; return next; });
          setSetupDrafts((current) => { const next = { ...current }; delete next[id]; return next; });
          setErrors((current) => { const next = { ...current }; delete next[id]; return next; });
          setResetContexts((current) => ({ ...current, [id]: {
            ...context, revision, legacyConflict: false, timeline: [], plans: [], legacy: [], history: [],
          } }));
          setNotice(`Budgets reset for ${ownerFor(id)!.name}. The previous configuration is retained in the community audit record.`);
          try {
            await onRefresh();
            setAccepted((current) => { const next = { ...current }; delete next[id]; return next; });
            setResetContexts((current) => { const next = { ...current }; delete next[id]; return next; });
          } catch {
            setError("Budgets were reset, but balances could not be refreshed. Reload the page before making further changes to this workgroup.");
          } finally { setBusy(false); }
        }} />}
      {proposing && consent && <ProposeBudgetDialog communityId={communityId}
        workgroupIds={pending.filter((group) => group.kind === "workgroup").map((group) => group.id)}
        projectNames={pending.map((group) => group.name)}
        settings={consent.settings} busy={busy} error={proposalError}
        onClose={() => setProposing(false)} onSubmit={(text) => void proposeAll(text)} />}
      {setupPrompt && <BudgetSetupDialog name={ownerFor(setupPrompt.id)!.name}
        context={contextFor(setupPrompt.id)} month={setupPrompt.month} cadence={setupPrompt.cadence} recurring={!month}
        initial={setupDrafts[setupPrompt.id]} onClose={() => setSetupPrompt(null)} onApply={(config) => {
          applySetup(setupPrompt.id, setupPrompt.rows, config);
          setSetupPrompt(null);
        }} />}
      {review && <BudgetDialog title="Review budget changes" onClose={() => setReview(false)}>
        <p className="mb-4 text-sm text-zinc-400">Save changes for {pending.length} projects. Earlier setups and superseded allocations remain in history.</p>
        <ul className="space-y-4">{pending.map((g) => {
          const config = configFor(g.id); const context = contextFor(g.id);
          const active = setupAt(context, config.startsOn);
          const switching = active?.mode !== config.mode || active?.cadence !== config.cadence;
          const affected = switching ? context?.plans.filter((p) => p.setup_id === active?.id && p.starts_on >= config.startsOn + "-01") ?? [] : [];
          return <li key={g.id} className="text-sm"><strong>{g.name}</strong>
            <p>{active ? setupLabel(active) : context?.legacyConflict ? "Mixed original budgets" : "No setup"} → {setupLabel(config)} · {active && isPastPeriod(config.startsOn, config.cadence) ? "correcting" : "from"} {config.startsOn}
              {!active && !context?.legacyConflict && nextSetupAfter(context, config.startsOn) && ` until ${nextSetupAfter(context, config.startsOn)!.starts_on.slice(0, 7)}`}</p>
            <p className="text-zinc-400">Previous amounts: {budgetAmountsText(active?.mode === "recurring" ? active.amounts : context?.plans.find((p) => p.setup_id === active?.id && p.starts_on === config.startsOn + "-01")?.amounts ?? [], "None")}</p>
            {saveGroups(g.id).map((plan) => <p key={plan.month}>
              Save{plan.mode === "recurring" ? "" : ` ${periodLabel(plan.month, plan.cadence)}`}: {plan.rows.filter((r) => !r.removed && !budgetRowBlank(r)).map((r) => `${r.amount} ${r.asset.fieldName}`).join(", ") || "No allocations"}
            </p>)}
            {config.reason && <p>{active ? "Correction" : "Reason"}: {config.reason}</p>}
            {affected.length > 0 && <p className="text-amber-400">Replaces future allocations: {affected.map((p) => p.starts_on.slice(0,7)).join(", ")}. These remain in history.</p>}
            {context?.legacyConflict && switching && <p className="text-amber-400">Original recurring and dated budgets stop applying from this date. Review the preserved originals in project history.</p>}
          </li>;
        })}</ul>
        <div className="mt-5 flex justify-end gap-2"><Button variant="secondary" onClick={() => setReview(false)}>Back to editing</Button>
          <Button onClick={() => void saveAll(true)}>Confirm and save all changes</Button></div>
      </BudgetDialog>}
      <div className="mb-4 flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 className="text-xl font-semibold">{title}</h2>
          <p className="mt-1 text-sm text-zinc-500">Tab between fields. Enter moves to the next amount. Changes stay in draft until you save.</p>
        </div>
        {month && <Button variant="secondary" disabled={working || !visible.some((group) => canEdit(group.id)) || month === "1000-01"}
          loading={copying} onClick={() => void copyPrevious()}>
          <Copy className="h-4 w-4" />Copy last {periodWord}
        </Button>}
      </div>
      {month && <p className="mb-4 text-xs text-zinc-500">
        {view === "quarter"
          ? "Copy fills each empty month from the same month of last quarter, and a quarterly project from last quarter. Projects that need a setup change are skipped."
          : "Copy fills missing amounts for monthly projects from last month. Change other project setups individually first."}
      </p>}
      <div className="mb-4 flex flex-wrap items-center gap-3">
        <div className="relative min-w-0 flex-1 sm:max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-3 h-4 w-4 text-zinc-500" />
          <Input className="!pl-9" type="search" placeholder="Find a workgroup, project or treasury…"
            aria-label="Search workgroups, projects and treasuries" value={query} disabled={working} onChange={(event) => setQuery(event.target.value)} />
        </div>
        {!month && <Select className="!w-auto" aria-label="Filter by recurring frequency" value={frequency}
          disabled={working} onChange={(event) => setFrequency(event.target.value)}>
          <option value="all">All frequencies</option>
          <option value="monthly">Monthly</option>
          <option value="quarterly">Quarterly</option>
        </Select>}
        <label className="flex items-center gap-2 text-sm text-zinc-400">
          <input type="checkbox" checked={changesOnly} disabled={working} onChange={(event) => setChangesOnly(event.target.checked)} />
          Changed projects only
        </label>
        <span className="text-xs text-zinc-500 sm:ml-auto">{visible.length} of {owners.length} projects</span>
      </div>
      {notice && <p role="status" className="mb-4 rounded-xl border border-[var(--accent-border)] bg-[var(--accent-soft)] p-3 text-sm">{notice}</p>}
      {lockedOwners.length > 0 && <p className="mb-4 text-sm text-zinc-400">
        Locked while their proposal is open:{" "}
        {lockedOwners.map((owner, index) => {
          const proposal = consent!.openProposals.get(owner.id)!;
          return <span key={owner.id}>{index > 0 && ", "}{owner.name} (<Link className="underline" href={consent!.proposalHref(proposal.id)}>#{proposal.number}</Link>)</span>;
        })}
      </p>}
      <ErrorText error={error} className="mb-4" />

      <div ref={table} role="table" aria-label={`${title} budget worksheet`} className="space-y-4"
        onKeyDown={(event) => {
          if (event.key !== "Enter" || !(event.target instanceof HTMLInputElement) || !event.target.hasAttribute("data-budget-amount")) return;
          event.preventDefault();
          const fields = Array.from(table.current?.querySelectorAll<HTMLInputElement>("input[data-budget-amount]:not(:disabled)") ?? []);
          const next = fields[fields.indexOf(event.target) + (event.shiftKey ? -1 : 1)];
          next?.focus(); next?.select();
        }}>
        <div role="row" className={`${gridClass} sticky top-[4.25rem] z-10 hidden rounded-xl border border-[var(--border)] bg-[var(--option-background)] px-5 py-2 text-xs font-semibold text-zinc-500 md:grid`}>
          <span role="columnheader">Project / token</span>
          {columns.map((column) => <span key={column.start} role="columnheader">{column.label}</span>)}
          <span role="columnheader">Changes</span>
        </div>
        {visible.map((group) => <BudgetProjectCard key={group.id} owner={group} view={view} columns={columns}
          cells={cellsFor(group.id)} fallback={fallback} rows={rowsFor(group.id)} frequency={frequency}
          config={setupDrafts[group.id]} context={contextFor(group.id)} referenceMonth={referenceMonth}
          onSetup={(cell) => promptSetup(group.id, rowsFor(group.id), cell)}
          onOpenQuarter={onOpenQuarter}
          // Reset is a workgroup action: treasury budgets have no legacy data and are corrected in place.
          // Under budget consent a reset is refused: budgets change only by proposal.
          onClearBudgets={!consent && isAdmin && group.kind === "workgroup" && canEdit(group.id) ? () => setResetPrompt({
            id: group.id, revision: revisions[group.id] ?? contextFor(group.id)?.revision ?? 0,
          }) : undefined}
          onReset={() => {
            setSetupDrafts((current) => { const next = { ...current }; delete next[group.id]; return next; });
            setDrafts((current) => { const next = { ...current }; delete next[group.id]; return next; });
          }} canEdit={canEdit(group.id)} disabled={working || !!accepted[group.id]}
          assets={assets} treasury={treasuries.find((treasury) => treasury.id === group.treasury_id)}
          error={errors[group.id]} showValidation={showValidation}
          onChange={(rows) => updateGroup(group.id, rows)} />)}
      </div>
      {visible.length === 0 && <EmptyState>
        {changesOnly ? "No changed projects in this view." : "No matching workgroups, projects or treasuries."}
      </EmptyState>}

      <div className="sticky bottom-3 z-10 mt-5 flex flex-wrap items-center justify-between gap-3 rounded-2xl border border-[var(--accent-border)] bg-[var(--option-background)] px-5 py-4 shadow-lg">
        <div role="status" aria-live="polite">
          <p className="text-sm font-semibold">{busy ? progress || (consent ? "Making the proposal…" : "Saving budgets…") : dirty
            ? `${plural(changed.length, "project")} with unsaved changes`
            : month && pending.length > 0 ? `${pending.length} projects ready to save for ${title}`
            : "No unsaved changes"}</p>
          <p className="mt-1 text-xs text-zinc-500">{hiddenChanges > 0
            ? `Includes ${plural(hiddenChanges, "project")} hidden by filters.`
            : consent ? "Budget consent is on: your changes go to a vote and apply when it passes."
              : month ? `Saves edited projects. Setup changes take effect from their selected dates.`
                : "Recurring changes start from a chosen date. Earlier amounts are preserved."}</p>
        </div>
        <div className="flex gap-2">
          <Button variant="secondary" disabled={working || !dirty} onClick={() => {
            if (!window.confirm("Discard all unsaved budget changes?")) return;
            setDrafts({}); setSetupDrafts({}); setRevisions({}); setErrors({}); setError(null); setNotice(""); setShowValidation(false);
          }}>Discard changes</Button>
          <Button disabled={working || pending.length === 0} loading={busy} onClick={() => void saveAll()}>
            <Save className="h-4 w-4" />{consent ? (busy ? "Proposing…" : "Propose changes…") : busy ? "Saving..." : "Save all changes"}
          </Button>
        </div>
      </div>
    </div>
  );
}
