// What the Payday list shows for a treasury: its tasks grouped by workgroup,
// the tasks routed to other treasuries set apart, and the view filters.
//
// Filters only change what is listed, never the payout: a selected task a
// filter hides stays selected and is counted in `hiddenSelected`.

import { isReady, routedElsewhere, type RoutingContext } from "./selection";
import type { PayableTask } from "./types";

/** "selected" and "unticked" split the ready tasks; "attention" is the rest. */
export type PaydayStatus = "all" | "selected" | "unticked" | "attention";

export interface PaydayFilter {
  status: PaydayStatus;
  workgroupId: string;
  query: string;
}

export const NO_FILTER: PaydayFilter = { status: "all", workgroupId: "", query: "" };

export function isFiltered(f: PaydayFilter): boolean {
  return f.status !== "all" || f.workgroupId !== "" || f.query.trim() !== "";
}

export interface PaydayGroup {
  workgroupId: string;
  name: string;
  /** Every task of the group this treasury may pay, filters ignored. */
  scope: PayableTask[];
  /** The tasks the filters show. */
  visible: PayableTask[];
  selectedCount: number;
  attentionCount: number;
}

export interface PaydayView {
  /** Workgroups with visible tasks, by name; tasks by number. */
  groups: PaydayGroup[];
  /** Tasks this treasury may not pay, by the treasury that must (filters except status apply). */
  elsewhere: Map<string, PayableTask[]>;
  elsewhereCount: number;
  /** Tasks this treasury may pay, per status, filters ignored. */
  counts: Record<PaydayStatus, number>;
  /** Selected tasks the filters hide: still in the payout. */
  hiddenSelected: number;
  /** Every workgroup with a payable task, for the filter. */
  workgroups: { id: string; name: string }[];
}

export function taskStatus(t: PayableTask, selected: ReadonlySet<string>): Exclude<PaydayStatus, "all"> {
  if (!isReady(t)) return "attention";
  return selected.has(t.id) ? "selected" : "unticked";
}

/** "#12", "12" or a piece of the title. */
export function matchesQuery(t: PayableTask, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  const number = /^#?(\d+)$/.exec(q);
  if (number) return t.number === Number(number[1]);
  return t.title.toLowerCase().includes(q);
}

const byNumber = (a: PayableTask, b: PayableTask) => a.number - b.number;
const byName = (a: { name: string }, b: { name: string }) => a.name.localeCompare(b.name);

export function buildPaydayView(
  tasks: PayableTask[],
  opts: {
    treasuryId: string;
    routing?: RoutingContext;
    selected: ReadonlySet<string>;
    filter: PaydayFilter;
  },
): PaydayView {
  const { treasuryId, routing, selected, filter } = opts;
  const counts: Record<PaydayStatus, number> = { all: 0, selected: 0, unticked: 0, attention: 0 };
  const groups = new Map<string, PaydayGroup>();
  const workgroups = new Map<string, string>();
  const elsewhere = new Map<string, PayableTask[]>();
  let elsewhereCount = 0;
  let hiddenSelected = 0;

  for (const t of [...tasks].sort(byNumber)) {
    workgroups.set(t.workgroup_id, t.workgroup.name);
    const passesView = (!filter.workgroupId || filter.workgroupId === t.workgroup_id) && matchesQuery(t, filter.query);
    const other = routedElsewhere(t, treasuryId, routing);
    if (other) {
      elsewhereCount++;
      if (passesView) elsewhere.set(other, [...(elsewhere.get(other) ?? []), t]);
      continue;
    }
    const status = taskStatus(t, selected);
    counts.all++;
    counts[status]++;
    let group = groups.get(t.workgroup_id);
    if (!group) {
      group = { workgroupId: t.workgroup_id, name: t.workgroup.name, scope: [], visible: [], selectedCount: 0, attentionCount: 0 };
      groups.set(t.workgroup_id, group);
    }
    group.scope.push(t);
    if (status === "selected") group.selectedCount++;
    if (status === "attention") group.attentionCount++;
    if (passesView && (filter.status === "all" || filter.status === status)) group.visible.push(t);
    else if (status === "selected") hiddenSelected++;
  }

  return {
    groups: [...groups.values()].filter((g) => g.visible.length > 0).sort(byName),
    elsewhere,
    elsewhereCount,
    counts,
    hiddenSelected,
    workgroups: [...workgroups].map(([id, name]) => ({ id, name })).sort(byName),
  };
}

/** Ready tasks each treasury may pay (an unrouted task counts for every one). */
export function readyCountByTreasury(
  tasks: PayableTask[],
  treasuryIds: readonly string[],
  routing?: RoutingContext,
): Map<string, number> {
  const ready = tasks.filter(isReady);
  return new Map(
    treasuryIds.map((id) => [id, ready.filter((t) => !routedElsewhere(t, id, routing)).length]),
  );
}
