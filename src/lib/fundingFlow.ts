// Pure funding-flow logic for the Dashboard: how treasury inflows bucket by
// month (server side, lib/db/dashboard.ts feeds it) and how inflows,
// transfers between the community's treasuries, workgroup payouts and direct
// payments become the Sankey's nodes and links (client side). Cash basis:
// inflows by block time, payouts by submission date, like the Treasury
// spending chart. Transfers are drawn from the receiver's tagged inflow only;
// the sender's payment row is never added, so a transfer is counted once.
// Amounts stay exact (BigInt strings); floats appear only in `value`, for
// the diagram's geometry.

import type { DashboardSeries } from "@/lib/api/types";
import { addQuantity, LOVELACE } from "@/lib/assets";
import { ALL_WORKGROUPS, bucketKey, chartNumber, type DashboardWindow, type UnitInfo } from "@/lib/dashboardSeries";
import { formatUnits } from "@/lib/format";

/** Where outside money came from; internal transfers are never a source. */
export type InflowKind = "contribution" | "revenue" | "other" | "unclassified";

export interface FlowInflow {
  treasuryId: string;
  unit: string;
  kind: InflowKind;
  /** The funding source an admin tied the inflow to; it names the flow's source. Absent when untagged. */
  fundingSourceId?: string;
  amount: string;
}

export interface FlowTransfer {
  fromTreasuryId: string;
  toTreasuryId: string;
  unit: string;
  amount: string;
}

/** One calendar month of inflows, summed per treasury, token and kind. */
export interface FlowMonth {
  month: string;
  inflows: FlowInflow[];
  transfers: FlowTransfer[];
}

/** The subset of an `incoming_txs` row the aggregation reads. */
export interface FlowIncomingRow {
  treasuryId: string;
  fromTreasuryId: string | null;
  incomingType: string;
  amountLovelace: string;
  assets: Record<string, string> | null;
  blockTime: string | null;
  fundingSourceId?: string | null;
}

/**
 * The income kind of an inflow's classification, or null when the inflow is
 * not income: a refund (already netted from spending through reconciliations)
 * or an admin-marked transfer with no known counterparty.
 */
export function inflowKind(incomingType: string): InflowKind | null {
  switch (incomingType) {
    case "contribution":
    case "revenue":
    case "unclassified":
      return incomingType;
    case "other":
      return "other";
    default:
      return null;
  }
}

/** An inflow's ADA and tokens as [unit, quantity] pairs, zero amounts left out. */
export function inflowAmounts(row: Pick<FlowIncomingRow, "amountLovelace" | "assets">): [string, string][] {
  const entries: [string, string][] = [];
  if (BigInt(row.amountLovelace) > 0n) entries.push([LOVELACE, row.amountLovelace]);
  for (const [unit, quantity] of Object.entries(row.assets ?? {})) {
    if (BigInt(quantity) > 0n) entries.push([unit, quantity]);
  }
  return entries;
}

const KEY = "|";

/**
 * Bucket inflows by block-time month (the window's bucket) over the window. A row linked to another
 * treasury of the community is a transfer whatever its type (the link is a
 * chain fact); the rest are income by kind, refunds and unlinked transfers
 * excluded. Rows without a block time are skipped.
 */
export function aggregateFlows(rows: readonly FlowIncomingRow[], window: DashboardWindow): FlowMonth[] {
  const inflows = new Map<string, Map<string, bigint>>(window.months.map((month) => [month, new Map()]));
  const transfers = new Map<string, Map<string, bigint>>(window.months.map((month) => [month, new Map()]));
  for (const row of rows) {
    if (!row.blockTime) continue;
    const month = bucketKey(row.blockTime, window.bucket);
    const kind = row.fromTreasuryId ? null : inflowKind(row.incomingType);
    const target = row.fromTreasuryId ? transfers.get(month) : kind ? inflows.get(month) : undefined;
    if (!target) continue;
    for (const [unit, quantity] of inflowAmounts(row)) {
      const key = row.fromTreasuryId
        ? [row.fromTreasuryId, row.treasuryId, unit].join(KEY)
        : [row.treasuryId, unit, kind, row.fundingSourceId ?? ""].join(KEY);
      addQuantity(target, key, BigInt(quantity));
    }
  }
  return window.months.map((month) => ({
    month,
    inflows: [...inflows.get(month)!]
      .map(([key, amount]) => {
        const [treasuryId, unit, kind, fundingSourceId] = key.split(KEY) as [string, string, InflowKind, string];
        return { treasuryId, unit, kind, ...(fundingSourceId && { fundingSourceId }), amount: amount.toString() };
      })
      .sort((a, b) => a.treasuryId.localeCompare(b.treasuryId) || a.unit.localeCompare(b.unit) || a.kind.localeCompare(b.kind) ||
        (a.fundingSourceId ?? "").localeCompare(b.fundingSourceId ?? "")),
    transfers: [...transfers.get(month)!]
      .map(([key, amount]) => {
        const [fromTreasuryId, toTreasuryId, unit] = key.split(KEY) as [string, string, string];
        return { fromTreasuryId, toTreasuryId, unit, amount: amount.toString() };
      })
      .sort((a, b) => a.fromTreasuryId.localeCompare(b.fromTreasuryId) ||
        a.toTreasuryId.localeCompare(b.toTreasuryId) || a.unit.localeCompare(b.unit)),
  }));
}

/** Every token that arrived as income or transfer in the window. */
export function flowUnits(flows: readonly FlowMonth[]): string[] {
  const units = new Set<string>();
  for (const month of flows) {
    for (const inflow of month.inflows) units.add(inflow.unit);
    for (const transfer of month.transfers) units.add(transfer.unit);
  }
  return [...units];
}

// --- Sankey graph ---------------------------------------------------------------

/** `direct` is the one sink for manual payments made straight from a treasury. */
export type FlowNodeKind = "source" | "treasury" | "workgroup" | "direct";
export type FlowLinkKind = "income" | "transfer" | "payout";

export interface FlowNode {
  key: string;
  name: string;
  kind: FlowNodeKind;
  /** Exact totals of the drawn links, for the tooltip. */
  inflow: string;
  outflow: string;
}

export interface FlowLink {
  source: number;
  target: number;
  /** Float for geometry only. */
  value: number;
  kind: FlowLinkKind;
  /** Exact amount and its formatted label. */
  amount: string;
  label: string;
}

export interface FlowGraph {
  nodes: FlowNode[];
  links: FlowLink[];
  /** Every raw flow as [from, to, amount], before netting. */
  table: string[][];
  /** Why the diagram differs from the table, if it does. */
  notes: string[];
}

/**
 * Columns the diagram lays out: the longest chain of links plus one. A
 * transfer may run from a later treasury to an earlier one, so depths are
 * relaxed until they settle (the links are a DAG: at most one pass per node).
 */
export function flowColumns(graph: Pick<FlowGraph, "nodes" | "links">): number {
  const depth = new Array<number>(graph.nodes.length).fill(0);
  for (let pass = 0, changed = true; changed && pass < graph.nodes.length; pass++) {
    changed = false;
    for (const link of graph.links) {
      const next = depth[link.source]! + 1;
      if (next > depth[link.target]!) { depth[link.target] = next; changed = true; }
    }
  }
  return Math.max(0, ...depth) + 1;
}

/** Width one column needs for its labels to stay readable. */
const FLOW_COLUMN_MIN_PX = 150;

/**
 * The width below which the diagram scrolls sideways instead of shrinking:
 * only a chain of four or more columns (a transfer between wallets) needs
 * one, shorter chains fit a phone once their labels are shortened.
 */
export function flowMinWidth(columns: number): number | null {
  return columns >= 4 ? columns * FLOW_COLUMN_MIN_PX : null;
}

/** Average glyph width of the 12px node label: an estimate, SVG text cannot be measured before it renders. */
export const FLOW_LABEL_CHAR_PX = 6.6;

/** A node label cut to the room beside its node, "…" marking the cut; empty when nothing legible fits. */
export function fitFlowLabel(name: string, roomPx: number): string {
  const chars = Math.floor(roomPx / FLOW_LABEL_CHAR_PX);
  if (name.length <= chars) return name;
  return chars < 3 ? "" : `${name.slice(0, chars - 1).trimEnd()}…`;
}

export const SOURCE_NAMES: Record<InflowKind, string> = {
  contribution: "Contributions",
  revenue: "Revenue",
  other: "Other income",
  unclassified: "Unclassified income",
};
const SOURCE_ORDER: InflowKind[] = ["contribution", "revenue", "other", "unclassified"];

interface RawLink {
  from: string;
  to: string;
  kind: FlowLinkKind;
  amount: bigint;
}

function sourceKey(kind: InflowKind): string {
  return `source:${kind}`;
}
/** A funding source is a source node too, named after the funder. */
const FUNDING_PREFIX = "funding=";
function fundingKey(id: string): string {
  return `source:${FUNDING_PREFIX}${id}`;
}
function treasuryKey(id: string): string {
  return `treasury:${id}`;
}
function workgroupKey(id: string): string {
  return `workgroup:${id}`;
}
const DIRECT_KEY = "direct:payments";
export const DIRECT_PAYMENTS_NAME = "Direct payments";

/**
 * Sum the selected months' flows of one token into raw links: source kind →
 * treasury (income), treasury → treasury (transfer), treasury → workgroup
 * (payouts net of refunds, from the series) and treasury → direct payments
 * (manual payments charged to the treasury's own budget). Zero and negative
 * links are dropped: a workgroup refunded more than it was paid has nothing
 * to draw.
 */
function collectLinks(input: {
  flows: readonly FlowMonth[];
  series: DashboardSeries;
  months: readonly string[];
  unit: string;
}): RawLink[] {
  const sums = new Map<string, RawLink>();
  const add = (from: string, to: string, kind: FlowLinkKind, amount: bigint) => {
    const key = `${from}${KEY}${to}`;
    const link = sums.get(key) ?? { from, to, kind, amount: 0n };
    link.amount += amount;
    sums.set(key, link);
  };
  const selected = new Set(input.months);
  for (const month of input.flows) {
    if (!selected.has(month.month)) continue;
    for (const inflow of month.inflows) {
      if (inflow.unit !== input.unit) continue;
      const from = inflow.fundingSourceId ? fundingKey(inflow.fundingSourceId) : sourceKey(inflow.kind);
      add(from, treasuryKey(inflow.treasuryId), "income", BigInt(inflow.amount));
    }
    for (const transfer of month.transfers) {
      if (transfer.unit === input.unit) {
        add(treasuryKey(transfer.fromTreasuryId), treasuryKey(transfer.toTreasuryId), "transfer", BigInt(transfer.amount));
      }
    }
  }
  for (const month of input.series.months) {
    if (!selected.has(month.month)) continue;
    for (const owner of month.byOwner) {
      const to = owner.ownerType === "treasury" ? DIRECT_KEY : workgroupKey(owner.ownerId);
      for (const cell of owner.spending) {
        if (cell.unit === input.unit) add(treasuryKey(cell.treasuryId), to, "payout", BigInt(cell.amount));
      }
    }
  }
  return [...sums.values()].filter((link) => link.amount > 0n);
}

/**
 * Keep one owner's spending, the treasuries paying it and what fed those: a
 * workgroup's payouts, or a treasury's direct payments.
 */
function narrowToOwner(links: RawLink[], ownerId: string): RawLink[] {
  const target = workgroupKey(ownerId);
  const source = treasuryKey(ownerId);
  const payouts = links.filter((link) => link.kind === "payout" &&
    (link.to === target || (link.to === DIRECT_KEY && link.from === source)));
  const treasuries = new Set(payouts.map((link) => link.from));
  const feeding = links.filter((link) => link.kind !== "payout" && treasuries.has(link.to));
  for (const link of feeding) if (link.kind === "transfer") treasuries.add(link.from);
  const income = links.filter((link) => link.kind === "income" && treasuries.has(link.to));
  return [...new Set([...payouts, ...feeding, ...income])];
}

/**
 * Transfers in both directions between two treasuries become one link of the
 * difference (none when equal); the diagram cannot draw a cycle.
 */
function netPairs(links: RawLink[], name: (key: string) => string, notes: string[]): RawLink[] {
  const out: RawLink[] = [];
  const seen = new Set<string>();
  for (const link of links) {
    if (link.kind !== "transfer") { out.push(link); continue; }
    const pair = [link.from, link.to].sort().join(KEY);
    if (seen.has(pair)) continue;
    seen.add(pair);
    const reverse = links.find((other) => other.kind === "transfer" && other.from === link.to && other.to === link.from);
    if (!reverse) { out.push(link); continue; }
    notes.push(`Transfers between ${name(link.from)} and ${name(link.to)} went both ways and are drawn net; the data table lists each direction.`);
    if (link.amount === reverse.amount) continue;
    const larger = link.amount > reverse.amount ? link : reverse;
    const smaller = larger === link ? reverse : link;
    out.push({ ...larger, amount: larger.amount - smaller.amount });
  }
  return out;
}

/** Drop the smallest transfer of every remaining cycle until the graph is a DAG. */
function breakCycles(links: RawLink[], name: (key: string) => string, notes: string[]): RawLink[] {
  let current = links;
  for (;;) {
    const nodes = new Set<string>();
    for (const link of current) { nodes.add(link.from); nodes.add(link.to); }
    const indegree = new Map<string, number>([...nodes].map((node) => [node, 0]));
    for (const link of current) indegree.set(link.to, indegree.get(link.to)! + 1);
    const queue = [...nodes].filter((node) => indegree.get(node) === 0);
    const done = new Set<string>();
    while (queue.length > 0) {
      const node = queue.shift()!;
      done.add(node);
      for (const link of current) {
        if (link.from !== node) continue;
        const left = indegree.get(link.to)! - 1;
        indegree.set(link.to, left);
        if (left === 0) queue.push(link.to);
      }
    }
    if (done.size === nodes.size) return current;
    const cyclic = current
      .filter((link) => link.kind === "transfer" && !done.has(link.from) && !done.has(link.to))
      .sort((a, b) => (a.amount < b.amount ? -1 : a.amount > b.amount ? 1 : 0));
    const victim = cyclic[0];
    if (!victim) return current.filter((link) => done.has(link.from) && done.has(link.to));
    notes.push(`The transfer from ${name(victim.from)} to ${name(victim.to)} closes a loop and is left out of the diagram; see the data table.`);
    current = current.filter((link) => link !== victim);
  }
}

/**
 * The Sankey for one token over the selected months: income sources →
 * treasuries → (other treasuries) → workgroups and direct payments. `table`
 * keeps every raw flow; `notes` explains what the diagram nets or omits.
 * Empty `links` means there is nothing to draw.
 */
export function fundingFlowGraph(input: {
  flows: readonly FlowMonth[];
  series: DashboardSeries;
  /** The selected month, or the months of the selected quarter. */
  months: readonly string[];
  unit: string;
  info: UnitInfo;
  /** `ALL_WORKGROUPS` or one budget owner id (a workgroup or a treasury). */
  workgroupId: string;
  treasuries: readonly { id: string; name: string }[];
  /** Workgroup id → display name. */
  names: ReadonlyMap<string, string>;
  /** Funding sources that tagged inflows name. */
  fundingSources?: readonly { id: string; name: string }[];
}): FlowGraph {
  const name = (key: string): string => {
    const [kind, id] = key.split(":", 2) as [string, string];
    if (kind === "source" && id.startsWith(FUNDING_PREFIX)) {
      return input.fundingSources?.find((source) => source.id === id.slice(FUNDING_PREFIX.length))?.name ?? "Funding source";
    }
    if (kind === "source") return SOURCE_NAMES[id as InflowKind] ?? id;
    if (kind === "treasury") return input.treasuries.find((treasury) => treasury.id === id)?.name ?? "Treasury";
    if (kind === "direct") return DIRECT_PAYMENTS_NAME;
    return input.names.get(id) ?? "Workgroup";
  };
  const format = (amount: bigint) => formatUnits(amount, input.info.decimals, input.info.ticker);

  let raw = collectLinks(input);
  if (input.workgroupId !== ALL_WORKGROUPS) raw = narrowToOwner(raw, input.workgroupId);
  const table = raw.map((link) => [name(link.from), name(link.to), format(link.amount)]);

  const notes: string[] = [];
  const drawn = breakCycles(netPairs(raw, name, notes), name, notes);

  const order = (key: string): number => {
    const [kind, id] = key.split(":", 2) as [string, string];
    // Named funders first, then the income kinds.
    if (kind === "source") return id.startsWith(FUNDING_PREFIX) ? -1 : SOURCE_ORDER.indexOf(id as InflowKind);
    if (kind === "treasury") {
      const index = input.treasuries.findIndex((treasury) => treasury.id === id);
      return 10 + (index < 0 ? input.treasuries.length : index);
    }
    // Workgroups by name, then the direct-payments sink last.
    return kind === "direct" ? 101 : 100;
  };
  const keys = [...new Set(drawn.flatMap((link) => [link.from, link.to]))]
    .sort((a, b) => order(a) - order(b) || name(a).localeCompare(name(b)));
  const index = new Map(keys.map((key, position) => [key, position]));
  const inflow = new Map<string, bigint>();
  const outflow = new Map<string, bigint>();
  for (const link of drawn) {
    addQuantity(outflow, link.from, link.amount);
    addQuantity(inflow, link.to, link.amount);
  }
  const nodes: FlowNode[] = keys.map((key) => ({
    key,
    name: name(key),
    kind: key.split(":", 1)[0] as FlowNodeKind,
    inflow: format(inflow.get(key) ?? 0n),
    outflow: format(outflow.get(key) ?? 0n),
  }));
  const links: FlowLink[] = [...drawn]
    .sort((a, b) => index.get(a.from)! - index.get(b.from)! || index.get(a.to)! - index.get(b.to)!)
    .map((link) => ({
    source: index.get(link.from)!,
    target: index.get(link.to)!,
    value: chartNumber(link.amount, input.info.decimals),
    kind: link.kind,
    amount: link.amount.toString(),
    label: format(link.amount),
  }));
  return { nodes, links, table, notes };
}
