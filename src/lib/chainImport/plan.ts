// Turn a label-190001 record plus the transaction's outputs into the rows the
// import writes, or into the list of reasons it cannot. Pure: the caller
// (run.ts) loads the community's state and executes the plan through the
// import_chain_tx RPC. Every issue is collected before returning, so an admin
// sees all of them at once, and a transaction is planned completely or not at
// all.

import { adaLovelaceFromAmounts, addQuantity, type AssetDef, LOVELACE, resolveAsset, resolveTaskAmounts, scaleDecimal } from "@/lib/assets";
import { budgetMonthFromPeriodCode } from "@/lib/budgets";
import { truncateUtf8, type PayoutMetadata } from "@/lib/cardano/metadata";
import type { PaymentMetadata } from "@/lib/cardano/paymentMetadata";
import { ChainImportIssueCode as Code, PayState, TxKind } from "@/lib/constants";
import { shortUnit } from "@/lib/format";
import { paymentDescription, payoutDescription } from "@/lib/txDescription";
import {
  ImportTaskMode,
  type ChainImportIssue,
  type ChainImportPlanResult,
  type ImportPlanPayment,
  type ImportPlanPayout,
  type ImportPlanTask,
} from "./types";

/** One output of the tx body; the array position is the output index. */
export interface ImportOutput {
  address: string;
  lovelace: bigint;
  /** Tokens by unit. */
  assets: Map<string, bigint>;
}

export interface ImportWorkgroup {
  id: string;
  name: string;
  archivedAt: string | null;
}

/** A task of this community that already carries a number the metadata names. */
export interface ImportExistingTask {
  id: string;
  number: number;
  title: string;
  workgroupId: string;
  payState: string;
  paidTxHash: string | null;
  archivedAt: string | null;
  amounts: Record<string, string> | null;
  bountyLovelace: string | number | null;
  /** Assignee wallets; null for an assignee not linked to a wallet yet. */
  wallets: (string | null)[];
}

interface TickerSources {
  /** community_assets. */
  registry: AssetDef[];
  /** The treasury's mints, ticker as fieldName. */
  mints: AssetDef[];
  /** The tokens sitting in the transaction's outputs, labelled from chain metadata. */
  candidates: AssetDef[];
}

export function stubTaskTitle(chainNumber: number): string {
  return `Imported task #${chainNumber}`;
}

/**
 * Tickers → unit and decimals: the community's registry, else its mints, else
 * the one token in the transaction's own outputs whose label is that ticker.
 * A wrong guess cannot slip through: the amounts are checked against the
 * outputs afterwards. `discovered` are the ones the registry did not know.
 */
export function resolveTickers(
  tickers: readonly string[],
  sources: TickerSources,
): { assets: (AssetDef | null)[]; discovered: AssetDef[]; issues: ChainImportIssue[] } {
  const discovered: AssetDef[] = [];
  const issues: ChainImportIssue[] = [];
  const assets = tickers.map((ticker) => {
    const known = resolveAsset(sources.registry, ticker);
    if (known) return known;
    const lower = ticker.toLowerCase();
    const minted = sources.mints.filter((m) => m.fieldName.toLowerCase() === lower);
    const found = minted.length > 0
      ? minted
      : sources.candidates.filter((c) => c.fieldName.toLowerCase() === lower);
    const [first] = found;
    if (!first || new Set(found.map((f) => f.unit)).size !== 1) {
      issues.push({ code: Code.UnknownTicker, ticker });
      return null;
    }
    const asset: AssetDef = { fieldName: ticker, unit: first.unit, decimals: first.decimals };
    discovered.push(asset);
    return asset;
  });
  return { assets, discovered, issues };
}

/**
 * The metadata's amounts against the real output: tokens exact, lovelace at
 * least the metadata's (the ledger's min-UTxO bump rides on token outputs),
 * no token the record does not name, and never the treasury's own change.
 */
export function checkOutputAmounts(
  outputIndex: number,
  output: ImportOutput,
  expected: ReadonlyMap<string, bigint>,
  treasuryAddress: string,
): ChainImportIssue[] {
  const mismatch = (detail: string): ChainImportIssue =>
    ({ code: Code.AmountMismatch, outputIndex, detail });
  if (output.address === treasuryAddress) return [mismatch("the output is the treasury's own change")];
  const issues: ChainImportIssue[] = [];
  const lovelace = expected.get(LOVELACE) ?? 0n;
  if (output.lovelace < lovelace) {
    issues.push(mismatch(`carries ${output.lovelace} lovelace, the record says ${lovelace}`));
  }
  for (const [unit, quantity] of expected) {
    if (unit === LOVELACE) continue;
    const actual = output.assets.get(unit) ?? 0n;
    if (actual !== quantity) {
      issues.push(mismatch(`carries ${actual} of ${shortUnit(unit)}, the record says ${quantity}`));
    }
  }
  for (const unit of output.assets.keys()) {
    if (!expected.has(unit)) issues.push(mismatch(`carries ${shortUnit(unit)}, which the record does not name`));
  }
  return issues;
}

/**
 * A metadata workgroup name → a workgroup here: an admin's earlier choice,
 * else the one active workgroup with that name. The builder truncates names
 * to the metadatum cap, so names are compared truncated.
 */
export function resolveWorkgroup(
  name: string,
  aliases: ReadonlyMap<string, string>,
  workgroups: readonly ImportWorkgroup[],
): { workgroupId: string } | { issue: ChainImportIssue } {
  const aliased = aliases.get(name);
  if (aliased) {
    const target = workgroups.find((w) => w.id === aliased);
    if (target && !target.archivedAt) return { workgroupId: target.id };
    if (target) return { issue: { code: Code.WorkgroupArchived, name } };
  }
  const named = workgroups.filter((w) => truncateUtf8(w.name) === name);
  const active = named.filter((w) => !w.archivedAt);
  const [only] = active;
  if (only && active.length === 1) return { workgroupId: only.id };
  if (active.length > 1) return { issue: { code: Code.WorkgroupAmbiguous, name } };
  return { issue: { code: named.length > 0 ? Code.WorkgroupArchived : Code.WorkgroupMissing, name } };
}

function sameAmounts(a: ReadonlyMap<string, bigint>, b: ReadonlyMap<string, bigint>): boolean {
  return a.size === b.size && [...a].every(([unit, quantity]) => b.get(unit) === quantity);
}

/**
 * What to do with a chain number: free → keep it; held by an unpaid task that
 * is this payment (same workgroup, same amounts, exactly these recipients,
 * since a payout pays every assignee) → settle that task; held by anything
 * else → a conflict, unless an admin chose a new number for it.
 */
export function resolveNumber(
  want: { chainNumber: number; workgroupId: string; units: ReadonlyMap<string, bigint>; wallets: readonly string[] },
  existing: ImportExistingTask | undefined,
  registry: AssetDef[],
  asNew: boolean,
): { mode: ImportTaskMode; taskId: string | null } | { issue: ChainImportIssue } {
  if (!existing) return { mode: ImportTaskMode.Keep, taskId: null };
  if (asNew) return { mode: ImportTaskMode.New, taskId: null };
  const conflict = (reason: string): { issue: ChainImportIssue } => ({
    issue: {
      code: Code.NumberConflict,
      chainNumber: want.chainNumber,
      existing: {
        id: existing.id,
        title: existing.title,
        payState: existing.payState,
        paidTxHash: existing.paidTxHash,
      },
      reason,
    },
  });
  if (existing.payState !== PayState.Payable) return conflict(`it is ${existing.payState}, not waiting for payment`);
  if (existing.archivedAt) return conflict("it is archived");
  if (existing.workgroupId !== want.workgroupId) return conflict("it belongs to another workgroup");
  let units: Map<string, bigint>;
  try {
    units = resolveTaskAmounts({ amounts: existing.amounts, bounty_lovelace: existing.bountyLovelace }, registry);
  } catch {
    return conflict("its amounts cannot be compared");
  }
  if (!sameAmounts(units, want.units)) return conflict("its amounts differ");
  const assignees = new Set(existing.wallets);
  if (assignees.has(null) || assignees.size !== want.wallets.length
    || !want.wallets.every((w) => assignees.has(w))) {
    return conflict("its assignees are not the wallets that were paid");
  }
  return { mode: ImportTaskMode.Settle, taskId: existing.id };
}

/** Scale one aligned amounts array; null when an amount is not a valid decimal. */
function scaleAmounts(
  amounts: readonly string[],
  assets: readonly AssetDef[],
): { units: Map<string, bigint>; display: Record<string, string> } | null {
  const units = new Map<string, bigint>();
  const display: Record<string, string> = {};
  for (const [k, raw] of amounts.entries()) {
    const asset = assets[k];
    if (raw === "" || !asset) continue;
    let quantity: bigint;
    try {
      quantity = scaleDecimal(raw, asset.decimals);
    } catch {
      return null;
    }
    if (quantity <= 0n) return null;
    addQuantity(units, asset.unit, quantity);
    display[asset.fieldName] = raw;
  }
  return units.size > 0 ? { units, display } : null;
}

export interface PayoutImportInput {
  meta: PayoutMetadata;
  communitySlug: string;
  treasuryAddress: string;
  outputs: readonly ImportOutput[];
  tickers: TickerSources;
  workgroups: readonly ImportWorkgroup[];
  /** Metadata workgroup name → workgroup id, as admins resolved them. */
  aliases: ReadonlyMap<string, string>;
  /** The community's tasks carrying any number the metadata names. */
  existingTasks: readonly ImportExistingTask[];
  /** Chain numbers an admin chose to import under a new number. */
  asNewNumbers: ReadonlySet<number>;
}

export function planPayoutImport(input: PayoutImportInput): ChainImportPlanResult {
  const { meta } = input;
  const issues: ChainImportIssue[] = [];
  if (meta.c !== truncateUtf8(input.communitySlug)) issues.push({ code: Code.SlugMismatch, slug: meta.c });

  const tickers = resolveTickers(meta.k, input.tickers);
  issues.push(...tickers.issues);
  const workgroupIds = meta.w.map((name) => {
    const resolved = resolveWorkgroup(name, input.aliases, input.workgroups);
    if ("issue" in resolved) issues.push(resolved.issue);
    return "issue" in resolved ? null : resolved.workgroupId;
  });
  // Amounts cannot be read without every ticker's decimals.
  if (tickers.assets.some((a) => a === null)) return { ok: false, issues };
  const assets = tickers.assets as AssetDef[];
  const registry = [...input.tickers.registry, ...tickers.discovered];

  interface Seen {
    w: number;
    b: number;
    raw: string;
    units: Map<string, bigint>;
    display: Record<string, string>;
    wallets: string[];
  }
  const seen = new Map<number, Seen>();
  const bad = (detail: string) => issues.push({ code: Code.BadMetadata, detail });

  for (const [outputIndex, tasks] of meta.p) {
    const output = input.outputs[outputIndex];
    if (!output) {
      issues.push({ code: Code.OutputMissing, outputIndex });
      continue;
    }
    const expected = new Map<string, bigint>();
    for (const [chainNumber, w, b, amounts] of tasks) {
      const scaled = scaleAmounts(amounts, assets);
      if (!scaled) {
        bad(`task #${chainNumber} has no readable amounts`);
        continue;
      }
      for (const [unit, quantity] of scaled.units) addQuantity(expected, unit, quantity);
      const raw = JSON.stringify(amounts);
      const prior = seen.get(chainNumber);
      if (!prior) {
        seen.set(chainNumber, { w, b, raw, ...scaled, wallets: [output.address] });
      } else if (prior.w !== w || prior.b !== b || prior.raw !== raw) {
        // Every assignee is paid the task's full amounts.
        bad(`task #${chainNumber} differs between outputs`);
      } else if (prior.wallets.includes(output.address)) {
        bad(`task #${chainNumber} pays ${output.address} twice`);
      } else {
        prior.wallets.push(output.address);
      }
    }
    issues.push(...checkOutputAmounts(outputIndex, output, expected, input.treasuryAddress));
  }
  if (seen.size === 0) bad("the record names no task");

  const existingByNumber = new Map(input.existingTasks.map((t) => [t.number, t]));
  const tasks: ImportPlanTask[] = [];
  const payouts: ImportPlanPayout[] = [];
  for (const [chainNumber, task] of seen) {
    const budgetMonth = budgetMonthFromPeriodCode(meta.b[task.b] ?? "");
    if (!budgetMonth) bad(`"${meta.b[task.b]}" is not a budget period`);
    const workgroupId = workgroupIds[task.w];
    if (!workgroupId || !budgetMonth) continue;
    const resolved = resolveNumber(
      { chainNumber, workgroupId, units: task.units, wallets: task.wallets },
      existingByNumber.get(chainNumber),
      registry,
      input.asNewNumbers.has(chainNumber),
    );
    if ("issue" in resolved) {
      issues.push(resolved.issue);
      continue;
    }
    tasks.push({
      chainNumber,
      mode: resolved.mode,
      taskId: resolved.taskId,
      workgroupId,
      title: stubTaskTitle(chainNumber),
      amounts: task.display,
      bountyLovelace: adaLovelaceFromAmounts(task.display),
      budgetMonth,
      wallets: task.wallets,
    });
    for (const wallet of task.wallets) {
      for (const [unit, quantity] of task.units) {
        payouts.push({ chainNumber, wallet, unit, amount: quantity.toString() });
      }
    }
  }
  if (issues.length > 0) return { ok: false, issues };

  const contributors = [...new Set(tasks.flatMap((t) => t.wallets))];
  return {
    ok: true,
    rows: {
      kind: TxKind.Payout,
      description: payoutDescription({
        tasks: tasks.length,
        payments: tasks.reduce((n, t) => n + t.wallets.length, 0),
        contributors: contributors.length,
        tickers: meta.k,
      }),
      contributors,
      assets: tickers.discovered,
      tasks,
      payouts,
      payments: [],
    },
  };
}

export interface PaymentImportInput {
  meta: PaymentMetadata;
  communitySlug: string;
  treasuryAddress: string;
  outputs: readonly ImportOutput[];
  tickers: TickerSources;
  /** The community's other treasuries. */
  siblings: readonly { id: string; name: string; address: string }[];
  /** Display labels of the recipients who are members, by wallet. */
  memberLabels: ReadonlyMap<string, string | null>;
}

export function planPaymentImport(input: PaymentImportInput): ChainImportPlanResult {
  const { meta } = input;
  const issues: ChainImportIssue[] = [];
  if (meta.c !== truncateUtf8(input.communitySlug)) issues.push({ code: Code.SlugMismatch, slug: meta.c });
  const tickers = resolveTickers(meta.k, input.tickers);
  issues.push(...tickers.issues);
  if (tickers.assets.some((a) => a === null)) return { ok: false, issues };
  const assets = tickers.assets as AssetDef[];

  const siblingByAddress = new Map(input.siblings.map((s) => [s.address, s]));
  const budgetMonth = meta.b === "" ? null : budgetMonthFromPeriodCode(meta.b);
  // One row per (recipient, unit), as build-payment writes them.
  const rows = new Map<string, ImportPlanPayment & { quantity: bigint }>();
  const seenOutputs = new Set<number>();

  for (const [outputIndex, amounts, flag] of meta.o) {
    const output = input.outputs[outputIndex];
    if (!output) {
      issues.push({ code: Code.OutputMissing, outputIndex });
      continue;
    }
    if (seenOutputs.has(outputIndex)) {
      issues.push({ code: Code.BadMetadata, detail: `output ${outputIndex} is listed twice` });
      continue;
    }
    seenOutputs.add(outputIndex);
    const scaled = scaleAmounts(amounts, assets);
    if (!scaled) {
      issues.push({ code: Code.BadMetadata, detail: `output ${outputIndex} has no readable amounts` });
      continue;
    }
    issues.push(...checkOutputAmounts(outputIndex, output, scaled.units, input.treasuryAddress));
    const sibling = siblingByAddress.get(output.address) ?? null;
    if (flag === 1 && !sibling) {
      issues.push({ code: Code.UnknownTreasury, outputIndex, address: output.address });
      continue;
    }
    if (flag === 0 && sibling) {
      issues.push({ code: Code.TransferMismatch, outputIndex, address: output.address });
      continue;
    }
    if (!sibling && !budgetMonth) {
      issues.push({ code: Code.BadMetadata, detail: `"${meta.b}" is not a budget period` });
      continue;
    }
    for (const [unit, quantity] of scaled.units) {
      const key = `${output.address}\n${unit}`;
      const row = rows.get(key);
      if (row) row.quantity += quantity;
      else {
        rows.set(key, {
          recipientWallet: output.address,
          recipientTreasuryId: sibling?.id ?? null,
          label: truncateUtf8(sibling?.name ?? input.memberLabels.get(output.address) ?? "") || null,
          unit,
          amount: "",
          budgetMonth: sibling ? null : budgetMonth,
          quantity,
        });
      }
    }
  }
  if (meta.o.length === 0) issues.push({ code: Code.BadMetadata, detail: "the record names no output" });
  if (issues.length > 0) return { ok: false, issues };

  const payments = [...rows.values()].map(({ quantity, ...row }) => ({ ...row, amount: quantity.toString() }));
  const recipients = new Set(payments.map((p) => p.recipientWallet));
  const transfers = new Set(payments.filter((p) => p.recipientTreasuryId).map((p) => p.recipientWallet));
  return {
    ok: true,
    rows: {
      kind: TxKind.Payment,
      description: paymentDescription({
        memo: meta.m?.trim() || null,
        recipients: recipients.size,
        transfers: transfers.size,
        tickers: meta.k,
      }),
      contributors: [],
      // Payments never write community_assets.
      assets: [],
      tasks: [],
      payouts: [],
      payments,
    },
  };
}
