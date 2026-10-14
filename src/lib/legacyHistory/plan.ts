// Plan a payment-history import: resolve the CSV's tickers to tokens and its
// workgroup names to workgroups, scale amounts exactly, place each line in
// its workgroup's budget period and mark what this wallet already holds.
// Pure: the preview and the import route run the same plan on the server,
// and import_legacy_history writes only what `legacyRpcRows` returns.
import { ADA_ASSET, addQuantity, resolveAsset, scaleDecimal, type AssetDef } from "@/lib/assets";
import { taskBudgetPeriod, type BudgetSetup } from "@/lib/budgetSetups";
import { LegacyIssueCode as Code } from "@/lib/constants";
import { matchTokensToFields, type MatchableToken } from "@/lib/tokenMatch";
import { normalizeWorkgroupName } from "./parse";
import type {
  LegacyImportPlan, LegacyIssue, LegacyRpcRow, LegacyToken, LegacyTotal, LegacyWorkgroup, ParsedHistory,
  PlannedAmount, PlannedRow, TickerResolution, WorkgroupResolution,
} from "./types";

export interface TickerContext {
  /** The community's token registry (community_assets). */
  registry: readonly AssetDef[];
  /**
   * Units an admin entered, keyed by lowercased ticker, with the token as the
   * chain describes it (null when the chain does not know that unit).
   */
  manual: ReadonlyMap<string, { unit: string; token: LegacyToken | null }>;
  /** Tokens earlier history imports of this community resolved. */
  history: readonly LegacyToken[];
  /** Tokens held by the community's treasuries. */
  wallet: readonly MatchableToken[];
}

/**
 * A CSV ticker → a token: ADA, then the registry, then the admin's unit, then
 * an earlier import's choice, then the one treasury token with that ticker.
 */
export function resolveLegacyTicker(ticker: string, ctx: TickerContext): TickerResolution {
  const lower = ticker.toLowerCase();
  if (lower === ADA_ASSET.fieldName.toLowerCase()) {
    return { ticker, status: "resolved", unit: ADA_ASSET.unit, decimals: ADA_ASSET.decimals, source: "ada" };
  }
  const registered = resolveAsset([...ctx.registry], ticker);
  if (registered) {
    return { ticker, status: "resolved", unit: registered.unit, decimals: registered.decimals, source: "registry" };
  }
  const manual = ctx.manual.get(lower);
  if (manual?.token) {
    return { ticker, status: "resolved", unit: manual.token.unit, decimals: manual.token.decimals, source: "manual" };
  }
  const earlier = uniqueByUnit(ctx.history.filter((t) => t.ticker.toLowerCase() === lower));
  const [only] = earlier;
  if (only && earlier.length === 1) {
    return { ticker, status: "resolved", unit: only.unit, decimals: only.decimals, source: "history" };
  }
  const match = matchTokensToFields([ticker], [], [...ctx.wallet]);
  const [auto] = match.auto;
  if (auto) return { ticker, status: "resolved", unit: auto.unit, decimals: auto.decimals, source: "wallet" };
  const candidates = match.ambiguous.get(ticker);
  if (candidates) {
    return {
      ticker,
      status: "ambiguous",
      candidates: candidates.map((t) => ({ unit: t.unit, ticker: t.ticker ?? ticker, decimals: t.decimals })),
    };
  }
  return manual ? { ticker, status: "unknown", manualUnit: manual.unit } : { ticker, status: "unknown" };
}

function uniqueByUnit(tokens: readonly LegacyToken[]): LegacyToken[] {
  const byUnit = new Map(tokens.map((t) => [t.unit, t]));
  return [...byUnit.values()];
}

/**
 * A normalized CSV workgroup name → a workgroup: an admin's earlier choice
 * (an alias whose name normalizes the same), else the one workgroup with that
 * name, archived ones included (history can belong to a wound-down
 * workgroup), preferring the only active one when several match.
 */
export function resolveLegacyWorkgroup(
  ref: string,
  name: string,
  aliases: ReadonlyMap<string, string>,
  workgroups: readonly LegacyWorkgroup[],
): WorkgroupResolution {
  const aliased = new Set<string>();
  for (const [alias, workgroupId] of aliases) {
    if (normalizeWorkgroupName(alias) === ref) aliased.add(workgroupId);
  }
  const viaAlias = workgroups.filter((w) => aliased.has(w.id));
  const [aliasOnly] = viaAlias;
  if (aliasOnly && viaAlias.length === 1) return { ref, name, status: "resolved", workgroup: aliasOnly };

  const named = workgroups.filter((w) => normalizeWorkgroupName(w.name) === ref);
  const [only] = named;
  if (only && named.length === 1) return { ref, name, status: "resolved", workgroup: only };
  const active = named.filter((w) => !w.archived);
  const [activeOnly] = active;
  if (activeOnly && active.length === 1) return { ref, name, status: "resolved", workgroup: activeOnly };
  if (named.length > 1) return { ref, name, status: "ambiguous", candidates: named };
  return { ref, name, status: "missing" };
}

/** What a line is compared by to find it already imported: case and spacing of the task ignored. */
export function canonicalRow(row: {
  recipientRef: string;
  workgroupRef: string;
  paidOn: string;
  task: string;
  amounts: readonly { unit: string; quantity: string }[];
}): string {
  const amounts = [...row.amounts].map((a) => `${a.unit}:${a.quantity}`).sort().join(",");
  const task = row.task.replace(/\s+/g, " ").trim().toLowerCase();
  return [row.recipientRef, row.workgroupRef, row.paidOn, task, amounts].join("|");
}

export interface PlanContext extends TickerContext {
  /** alias name → workgroup id (workgroup_import_aliases). */
  aliases: ReadonlyMap<string, string>;
  workgroups: readonly LegacyWorkgroup[];
  /** Budget setup timeline per workgroup id. */
  setups: ReadonlyMap<string, readonly Pick<BudgetSetup, "starts_on" | "cadence">[]>;
  /** Duplicate keys this wallet already holds (minus a batch being replaced). */
  existingKeys: ReadonlySet<string>;
  /** sha256 hex of a canonical row. */
  hash: (canonical: string) => string;
  /** Import lines already held, too (the admin checked they are separate payments). */
  includeDuplicates: boolean;
}

export function planLegacyImport(parsed: ParsedHistory, ctx: PlanContext): LegacyImportPlan {
  const issues: LegacyIssue[] = [...parsed.issues];
  const lineIssue = (line: number, code: LegacyIssue["code"], extra: Partial<LegacyIssue> = {}) =>
    issues.push({ code, line, severity: "error", ...extra });

  const used = new Set(parsed.rows.flatMap((row) => row.amounts.map((a) => a.ticker)));
  const tickers = parsed.tickers.filter((t) => used.has(t)).map((t) => resolveLegacyTicker(t, ctx));
  const byTicker = new Map(tickers.map((t) => [t.ticker, t]));
  for (const t of tickers) {
    if (t.status !== "resolved") issues.push({ code: Code.UnresolvedTicker, line: null, severity: "error", column: t.ticker });
  }
  const unitOwners = new Map<string, string[]>();
  for (const t of tickers) {
    if (t.status === "resolved") unitOwners.set(t.unit, [...(unitOwners.get(t.unit) ?? []), t.ticker]);
  }
  for (const owners of unitOwners.values()) {
    if (owners.length > 1) {
      issues.push({ code: Code.SameToken, line: null, severity: "error", column: owners.join(", ") });
    }
  }

  const refs = new Map<string, string>();
  for (const row of parsed.rows) if (!refs.has(row.workgroupRef)) refs.set(row.workgroupRef, row.workgroupName);
  const workgroups = [...refs].map(([ref, name]) => resolveLegacyWorkgroup(ref, name, ctx.aliases, ctx.workgroups));
  const byRef = new Map(workgroups.map((w) => [w.ref, w]));
  for (const w of workgroups) {
    if (w.status !== "resolved") {
      issues.push({ code: Code.UnresolvedWorkgroup, line: null, severity: "error", value: w.name });
    } else if (w.workgroup.archived) {
      issues.push({ code: Code.ArchivedWorkgroup, line: null, severity: "warning", value: w.workgroup.name });
    }
  }

  const firstLine = new Map<string, number>();
  const rows: PlannedRow[] = parsed.rows.map((row) => {
    const before = issues.length;
    const amounts: PlannedAmount[] = row.amounts.map((amount) => {
      const token = byTicker.get(amount.ticker);
      if (!token || token.status !== "resolved") {
        return { ticker: amount.ticker, raw: amount.raw, unit: null, decimals: null, quantity: null };
      }
      let quantity: string | null = null;
      try {
        quantity = scaleDecimal(amount.raw, token.decimals).toString();
      } catch {
        lineIssue(row.line, Code.TooManyDecimals, { column: amount.ticker, value: amount.raw });
      }
      return { ticker: amount.ticker, raw: amount.raw, unit: token.unit, decimals: token.decimals, quantity };
    });
    const group = byRef.get(row.workgroupRef);
    const workgroupId = group?.status === "resolved" ? group.workgroup.id : null;
    const budgetMonth = workgroupId === null ? null
      : `${taskBudgetPeriod(row.paidOn, ctx.setups.get(workgroupId) ?? [], row.paidOn.slice(0, 7)).month}-01`;

    const complete = amounts.every((a) => a.quantity !== null && a.unit !== null);
    let dedupeKey: string | null = null;
    let duplicateOfLine: number | null = null;
    if (complete) {
      const canonical = canonicalRow({
        ...row,
        amounts: amounts.map((a) => ({ unit: a.unit!, quantity: a.quantity! })),
      });
      dedupeKey = ctx.hash(canonical);
      const earlier = firstLine.get(canonical);
      if (earlier === undefined) {
        firstLine.set(canonical, row.line);
      } else {
        duplicateOfLine = earlier;
        issues.push({ code: Code.DuplicateInFile, line: row.line, severity: "warning", value: String(earlier) });
      }
    }
    const invalid = issues.slice(before).some((i) => i.severity === "error");
    return {
      line: row.line,
      recipientRef: row.recipientRef,
      task: row.task,
      paidOn: row.paidOn,
      budgetMonth,
      workgroupRef: row.workgroupRef,
      workgroupId,
      amounts,
      dedupeKey,
      status: invalid ? "invalid" : dedupeKey !== null && ctx.existingKeys.has(dedupeKey) ? "duplicate" : "new",
      duplicateOfLine,
    };
  });

  const importable = rows.filter((row) => willImport(row, ctx.includeDuplicates));
  const invalidLines = new Set(
    issues.filter((i) => i.severity === "error" && i.line !== null).map((i) => i.line!),
  );
  const ready = !issues.some((i) => i.severity === "error") && importable.length > 0 &&
    importable.every((row) => row.workgroupId !== null && row.dedupeKey !== null);

  return {
    tickers,
    workgroups,
    rows,
    issues,
    counts: {
      lines: parsed.lineCount,
      new: rows.filter((r) => r.status === "new").length,
      duplicates: rows.filter((r) => r.status === "duplicate").length,
      fileDuplicates: rows.filter((r) => r.duplicateOfLine !== null).length,
      invalid: invalidLines.size,
    },
    totals: legacyTotals(importable, tickers),
    ready,
  };
}

function willImport(row: PlannedRow, includeDuplicates: boolean): boolean {
  return row.status === "new" || (row.status === "duplicate" && includeDuplicates);
}

/** Per workgroup and overall, per token, of the lines an import would add. */
function legacyTotals(rows: readonly PlannedRow[], tickers: readonly TickerResolution[]): LegacyTotal[] {
  const info = new Map<string, { ticker: string; decimals: number }>();
  for (const t of tickers) if (t.status === "resolved") info.set(t.unit, { ticker: t.ticker, decimals: t.decimals });
  const sums = new Map<string, bigint>();
  for (const row of rows) {
    for (const a of row.amounts) {
      if (a.unit === null || a.quantity === null) continue;
      addQuantity(sums, `${row.workgroupId ?? ""}|${a.unit}`, BigInt(a.quantity));
      addQuantity(sums, `*|${a.unit}`, BigInt(a.quantity));
    }
  }
  return [...sums].map(([key, amount]) => {
    const [owner, unit] = key.split("|") as [string, string];
    const token = info.get(unit) ?? { ticker: unit, decimals: 0 };
    return {
      workgroupId: owner === "*" ? null : owner,
      unit,
      ticker: token.ticker,
      decimals: token.decimals,
      amount: amount.toString(),
    };
  });
}

/** The rows import_legacy_history receives; empty unless the plan is ready. */
export function legacyRpcRows(plan: LegacyImportPlan, includeDuplicates: boolean): LegacyRpcRow[] {
  if (!plan.ready) return [];
  return plan.rows.filter((row) => willImport(row, includeDuplicates)).map((row) => ({
    lineNo: row.line,
    workgroupId: row.workgroupId!,
    workgroupRef: row.workgroupRef,
    recipientRef: row.recipientRef,
    task: row.task,
    paidOn: row.paidOn,
    budgetMonth: row.budgetMonth!,
    dedupeKey: row.dedupeKey!,
    amounts: row.amounts.map((a) => ({
      unit: a.unit!,
      ticker: a.unit === ADA_ASSET.unit ? ADA_ASSET.fieldName : a.ticker,
      decimals: a.decimals!,
      amount: a.quantity!,
    })),
  }));
}

/** Rows the preview always lists (anything not plainly new), then clean ones up to `cleanLimit`. */
export function previewRows(plan: LegacyImportPlan, cleanLimit = 100): { rows: PlannedRow[]; truncated: boolean } {
  const flagged = new Set(plan.issues.flatMap((i) => (i.line === null ? [] : [i.line])));
  let clean = 0;
  const rows = plan.rows.filter((row) => {
    if (row.status !== "new" || row.duplicateOfLine !== null || flagged.has(row.line)) return true;
    clean += 1;
    return clean <= cleanLimit;
  });
  const shown = rows.slice(0, 500);
  return { rows: shown, truncated: shown.length < plan.rows.length };
}
