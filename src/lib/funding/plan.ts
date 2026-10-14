// Planned vs received for funding sources: what a commitment planned in
// total and up to today, what arrived in the inflows tied to it, and the
// difference, per token and (for recurring commitments and schedules) per
// period. Pure and client-safe; amounts stay exact BigInt strings.
import { addQuantity } from "@/lib/assets";
import { alignBudgetMonth, monthOf, periodLabel, shiftMonth, type BudgetCadence } from "@/lib/budgets";
import type { FundingAmount, FundingCommitmentRow, FundingPeriodRow } from "@/lib/db/types";
import { inflowAmounts } from "@/lib/fundingFlow";

/** The part of an `incoming_txs` row the summaries read. */
export interface FundingInflow {
  txHash: string;
  blockTime: string | null;
  sourceId: string;
  commitmentId: string | null;
  amountLovelace: string;
  assets: Record<string, string> | null;
}

export interface TokenFigures {
  unit: string;
  /** The whole commitment; null when a recurring commitment has no end. */
  planned: string | null;
  /** Planned up to the current period. */
  due: string;
  received: string;
  /** received − due: positive is over the plan, negative under. */
  difference: string;
  /** planned − received; null when open-ended. */
  remaining: string | null;
}

export interface PeriodFigures {
  /** First month of the period, "YYYY-MM". */
  start: string;
  label: string;
  planned: Record<string, string>;
  received: Record<string, string>;
  /** Running received − planned through this period, per token. */
  runningDifference: Record<string, string>;
}

export interface CommitmentSummary {
  id: string;
  tokens: TokenFigures[];
  /** Recurring commitments and schedules: each period with a plan or a receipt. */
  periods: PeriodFigures[];
}

export interface SourceSummary {
  tokens: TokenFigures[];
  commitments: CommitmentSummary[];
  /** Received in inflows tied to the source but to no commitment. */
  unassigned: Record<string, string>;
}

type Sums = Map<string, bigint>;

const amountsMap = (amounts: readonly FundingAmount[]): Sums =>
  new Map(amounts.map((a) => [a.unit, BigInt(a.amount)]));

function addAll(target: Sums, source: ReadonlyMap<string, bigint>, times = 1n): void {
  for (const [unit, quantity] of source) addQuantity(target, unit, quantity * times);
}

const record = (sums: ReadonlyMap<string, bigint>): Record<string, string> =>
  Object.fromEntries([...sums].map(([unit, quantity]) => [unit, quantity.toString()]));

function inflowSums(inflow: FundingInflow): Sums {
  return new Map(inflowAmounts(inflow).map(([unit, quantity]) => [unit, BigInt(quantity)]));
}

const step = (cadence: BudgetCadence | null) => (cadence === "quarterly" ? 3 : 1);

/**
 * The planned periods of a commitment through `throughMonth` ("YYYY-MM"): a
 * recurring commitment's periods from its start to its end (or through
 * `throughMonth` when open-ended), a schedule's stored periods. None for a
 * one-off.
 */
export function plannedPeriods(
  commitment: FundingCommitmentRow,
  periods: readonly FundingPeriodRow[],
  throughMonth: string,
): { start: string; amounts: Sums }[] {
  if (commitment.kind === "schedule") {
    return periods
      .filter((p) => p.commitment_id === commitment.id)
      .map((p) => ({ start: p.starts_on.slice(0, 7), amounts: amountsMap(p.amounts) }))
      .sort((a, b) => a.start.localeCompare(b.start));
  }
  if (commitment.kind !== "recurring" || !commitment.starts_on) return [];
  const last = commitment.ends_on?.slice(0, 7) ?? alignBudgetMonth(throughMonth, commitment.cadence);
  const out: { start: string; amounts: Sums }[] = [];
  const amounts = amountsMap(commitment.amounts);
  for (let month = commitment.starts_on.slice(0, 7); month <= last; month = shiftMonth(month, step(commitment.cadence))) {
    out.push({ start: month, amounts });
  }
  return out;
}

/** Planned vs received for one commitment at `now`. */
export function commitmentSummary(
  commitment: FundingCommitmentRow,
  periods: readonly FundingPeriodRow[],
  inflows: readonly FundingInflow[],
  now: Date,
): CommitmentSummary {
  const current = alignBudgetMonth(monthOf(now), commitment.cadence);
  const mine = inflows.filter((inflow) => inflow.commitmentId === commitment.id);
  const received: Sums = new Map();
  for (const inflow of mine) addAll(received, inflowSums(inflow));

  const planned: Sums = new Map();
  const due: Sums = new Map();
  let openEnded = false;
  let periodRows: PeriodFigures[] = [];

  if (commitment.kind === "one_off") {
    addAll(planned, amountsMap(commitment.amounts));
    if (!commitment.starts_on || commitment.starts_on.slice(0, 7) <= monthOf(now)) addAll(due, planned);
  } else {
    // Received by period: an inflow counts in the period its block time falls in.
    const receivedBy = new Map<string, Sums>();
    let lastReceived = "";
    for (const inflow of mine) {
      if (!inflow.blockTime) continue;
      const start = alignBudgetMonth(monthOf(inflow.blockTime), commitment.cadence);
      const sums = receivedBy.get(start) ?? new Map();
      addAll(sums, inflowSums(inflow));
      receivedBy.set(start, sums);
      if (start > lastReceived) lastReceived = start;
    }
    openEnded = commitment.kind === "recurring" && !commitment.ends_on;
    const through = lastReceived > current ? lastReceived : current;
    const plan = plannedPeriods(commitment, periods, through);
    for (const period of plan) {
      if (!openEnded || period.start <= current) addAll(planned, period.amounts);
      if (period.start <= current) addAll(due, period.amounts);
    }
    const starts = [...new Set([...plan.map((p) => p.start), ...receivedBy.keys()])].sort();
    const running: Sums = new Map();
    const planBy = new Map(plan.map((p) => [p.start, p.amounts]));
    periodRows = starts.map((start) => {
      const plannedHere = planBy.get(start) ?? new Map<string, bigint>();
      const receivedHere = receivedBy.get(start) ?? new Map<string, bigint>();
      addAll(running, receivedHere);
      addAll(running, plannedHere, -1n);
      return {
        start,
        label: periodLabel(start, commitment.cadence),
        planned: record(plannedHere),
        received: record(receivedHere),
        runningDifference: record(running),
      };
    });
  }

  return { id: commitment.id, tokens: tokenFigures(planned, due, received, openEnded), periods: periodRows };
}

function tokenFigures(planned: Sums, due: Sums, received: Sums, openEnded: boolean | ReadonlySet<string>): TokenFigures[] {
  const units = [...new Set([...planned.keys(), ...due.keys(), ...received.keys()])];
  return units.map((unit) => {
    const open = typeof openEnded === "boolean" ? openEnded : openEnded.has(unit);
    const p = planned.get(unit) ?? 0n;
    const d = due.get(unit) ?? 0n;
    const r = received.get(unit) ?? 0n;
    return {
      unit,
      planned: open ? null : p.toString(),
      due: d.toString(),
      received: r.toString(),
      difference: (r - d).toString(),
      remaining: open ? null : (p - r).toString(),
    };
  });
}

/** A source's commitments summed, plus what arrived tied to the source alone. */
export function sourceSummary(
  sourceId: string,
  commitments: readonly FundingCommitmentRow[],
  periods: readonly FundingPeriodRow[],
  inflows: readonly FundingInflow[],
  now: Date,
): SourceSummary {
  const own = commitments.filter((c) => c.source_id === sourceId);
  const ownInflows = inflows.filter((inflow) => inflow.sourceId === sourceId);
  const summaries = own.map((c) => commitmentSummary(c, periods, ownInflows, now));
  const planned: Sums = new Map();
  const due: Sums = new Map();
  const received: Sums = new Map();
  const open = new Set<string>();
  for (const summary of summaries) {
    for (const t of summary.tokens) {
      if (t.planned === null) open.add(t.unit);
      else addQuantity(planned, t.unit, BigInt(t.planned));
      addQuantity(due, t.unit, BigInt(t.due));
      addQuantity(received, t.unit, BigInt(t.received));
    }
  }
  // Inflows tied to a commitment that no longer exists count as unassigned.
  const known = new Set(own.map((c) => c.id));
  const unassigned: Sums = new Map();
  for (const inflow of ownInflows) {
    if (inflow.commitmentId && known.has(inflow.commitmentId)) continue;
    addAll(unassigned, inflowSums(inflow));
  }
  addAll(received, unassigned);
  return { tokens: tokenFigures(planned, due, received, open), commitments: summaries, unassigned: record(unassigned) };
}
