// Plan a previous-wallet receipts import: resolve tickers and funding source /
// commitment names, scale amounts, mark duplicates. Pure.
import { ADA_ASSET, addQuantity, scaleDecimal } from "@/lib/assets";
import { LegacyIssueCode as Code } from "@/lib/constants";
import { resolveLegacyTicker, type TickerContext } from "./plan";
import type { LegacyIssue, LegacyTotal, PlannedAmount, TickerResolution } from "./types";
import type {
  CommitmentResolution, FundingCommitmentRef, FundingSourceRef, LegacyReceiptImportPlan,
  LegacyReceiptRpcRow, ParsedReceipts, PlannedReceiptRow, SourceResolution,
} from "./receiptTypes";
import { normalizeFundingName } from "./receiptParse";

export function resolveFundingSource(
  ref: string,
  name: string,
  sources: readonly FundingSourceRef[],
  aliases?: ReadonlyMap<string, string>,
): SourceResolution {
  if (ref === "") return { ref: "", name: "", status: "none" };
  const aliased = aliases?.get(ref);
  if (aliased) {
    const found = sources.find((s) => s.id === aliased);
    if (found) return { ref, name, status: "resolved", source: found };
  }
  const named = sources.filter((s) => normalizeFundingName(s.name) === ref);
  const [only] = named;
  if (only && named.length === 1) return { ref, name, status: "resolved", source: only };
  if (named.length > 1) return { ref, name, status: "ambiguous", candidates: named };
  return { ref, name, status: "missing" };
}

export function resolveFundingCommitment(
  ref: string,
  name: string,
  sourceId: string | null,
  commitments: readonly FundingCommitmentRef[],
  aliases?: ReadonlyMap<string, string>,
): CommitmentResolution {
  if (ref === "") return { ref: "", name: "", status: "none" };
  if (sourceId === null) return { ref, name, status: "missing" };
  const aliasKey = `${sourceId}|${ref}`;
  const aliased = aliases?.get(aliasKey) ?? aliases?.get(ref);
  if (aliased) {
    const found = commitments.find((c) => c.id === aliased && c.sourceId === sourceId);
    if (found) return { ref, name, status: "resolved", commitment: found };
  }
  const named = commitments.filter(
    (c) => c.sourceId === sourceId && normalizeFundingName(c.name) === ref,
  );
  const [only] = named;
  if (only && named.length === 1) return { ref, name, status: "resolved", commitment: only };
  if (named.length > 1) return { ref, name, status: "ambiguous", candidates: named };
  return { ref, name, status: "missing" };
}

/** What a receipt line is compared by: chain output + attribution fields. */
export function canonicalReceiptRow(row: {
  receivedOn: string;
  sourceRef: string;
  commitmentRef: string;
  note: string | null;
  txHash: string;
  outputIndex: number;
  amounts: readonly { unit: string; quantity: string }[];
}): string {
  const amounts = [...row.amounts].map((a) => `${a.unit}:${a.quantity}`).sort().join(",");
  const note = (row.note ?? "").replace(/\s+/g, " ").trim().toLowerCase();
  return [
    row.txHash.toLowerCase(),
    String(row.outputIndex),
    row.receivedOn,
    row.sourceRef,
    row.commitmentRef,
    note,
    amounts,
  ].join("|");
}

export interface ReceiptPlanContext extends TickerContext {
  sources: readonly FundingSourceRef[];
  commitments: readonly FundingCommitmentRef[];
  /** CSV source ref → funding_sources.id (admin choice when ambiguous). */
  sourceAliases?: ReadonlyMap<string, string>;
  /** `${sourceId}|${commitmentRef}` → funding_commitments.id. */
  commitmentAliases?: ReadonlyMap<string, string>;
  /** Applied to every blank-source row (must be a community funding source). */
  defaultSourceId?: string | null;
  /** Optional commitment under defaultSourceId, for blank commitment cells. */
  defaultCommitmentId?: string | null;
  existingKeys: ReadonlySet<string>;
  hash: (canonical: string) => string;
  includeDuplicates: boolean;
}

export function planLegacyReceipts(parsed: ParsedReceipts, ctx: ReceiptPlanContext): LegacyReceiptImportPlan {
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

  let defaultSource: FundingSourceRef | null = null;
  let defaultCommitment: FundingCommitmentRef | null = null;
  if (ctx.defaultSourceId) {
    defaultSource = ctx.sources.find((s) => s.id === ctx.defaultSourceId) ?? null;
    if (!defaultSource) {
      issues.push({ code: Code.UnresolvedSource, line: null, severity: "error", value: "chosen default" });
    } else if (ctx.defaultCommitmentId) {
      defaultCommitment = ctx.commitments.find(
        (c) => c.id === ctx.defaultCommitmentId && c.sourceId === defaultSource!.id,
      ) ?? null;
      if (!defaultCommitment) {
        issues.push({ code: Code.UnresolvedCommitment, line: null, severity: "error", value: "chosen default" });
      }
    }
  } else if (ctx.defaultCommitmentId) {
    issues.push({ code: Code.CommitmentWithoutSource, line: null, severity: "error", value: "chosen default" });
  }

  const sourceRefs = new Map<string, string>();
  for (const row of parsed.rows) {
    if (row.sourceRef !== "" && !sourceRefs.has(row.sourceRef)) sourceRefs.set(row.sourceRef, row.sourceName);
  }
  const sources = [...sourceRefs].map(([ref, name]) =>
    resolveFundingSource(ref, name, ctx.sources, ctx.sourceAliases));
  const bySource = new Map(sources.map((s) => [s.ref, s]));
  for (const s of sources) {
    if (s.status !== "resolved" && s.status !== "none") {
      issues.push({ code: Code.UnresolvedSource, line: null, severity: "error", value: s.name });
    }
  }

  const commitmentKeys = new Map<string, { ref: string; name: string; sourceId: string | null }>();
  for (const row of parsed.rows) {
    if (row.commitmentRef === "") continue;
    const source = bySource.get(row.sourceRef);
    const sourceId = source?.status === "resolved" ? source.source.id : null;
    const key = `${sourceId ?? ""}|${row.commitmentRef}`;
    if (!commitmentKeys.has(key)) {
      commitmentKeys.set(key, { ref: row.commitmentRef, name: row.commitmentName, sourceId });
    }
  }
  const commitments = [...commitmentKeys.values()].map((c) =>
    resolveFundingCommitment(c.ref, c.name, c.sourceId, ctx.commitments, ctx.commitmentAliases));
  const byCommitment = new Map(
    commitments.map((c) => {
      const sourceId = c.status === "resolved" ? c.commitment.sourceId
        : [...commitmentKeys.values()].find((k) => k.ref === c.ref)?.sourceId ?? "";
      return [`${sourceId}|${c.ref}`, c] as const;
    }),
  );
  for (const c of commitments) {
    if (c.status !== "resolved" && c.status !== "none") {
      issues.push({ code: Code.UnresolvedCommitment, line: null, severity: "error", value: c.name });
    }
  }

  const firstLine = new Map<string, number>();
  const rows: PlannedReceiptRow[] = parsed.rows.map((row) => {
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

    const source = bySource.get(row.sourceRef);
    let sourceId = source?.status === "resolved" ? source.source.id : null;
    const fromCsv = byCommitment.get(`${sourceId ?? ""}|${row.commitmentRef}`);
    let commitmentId = fromCsv?.status === "resolved" ? fromCsv.commitment.id : null;
    // Blank source (and blank commitment): stamp the preview's default choice.
    let canonicalSource = row.sourceRef;
    let canonicalCommitment = row.commitmentRef;
    if (row.sourceRef === "" && defaultSource) {
      sourceId = defaultSource.id;
      canonicalSource = normalizeFundingName(defaultSource.name);
      if (row.commitmentRef === "" && defaultCommitment) {
        commitmentId = defaultCommitment.id;
        canonicalCommitment = normalizeFundingName(defaultCommitment.name);
      }
    }

    const complete = amounts.every((a) => a.quantity !== null && a.unit !== null)
      && (row.sourceRef === "" || sourceId !== null)
      && (row.commitmentRef === "" || commitmentId !== null);
    let dedupeKey: string | null = null;
    let duplicateOfLine: number | null = null;
    if (complete) {
      const canonical = canonicalReceiptRow({
        receivedOn: row.receivedOn,
        sourceRef: canonicalSource,
        commitmentRef: canonicalCommitment,
        note: row.note,
        txHash: row.txHash,
        outputIndex: row.outputIndex,
        amounts: amounts.map((a) => ({ unit: a.unit!, quantity: a.quantity! })),
      });
      dedupeKey = ctx.hash(canonical);
      const earlier = firstLine.get(canonical);
      if (earlier === undefined) firstLine.set(canonical, row.line);
      else {
        duplicateOfLine = earlier;
        issues.push({ code: Code.DuplicateInFile, line: row.line, severity: "warning", value: String(earlier) });
      }
    }
    const invalid = issues.slice(before).some((i) => i.severity === "error");
    return {
      line: row.line,
      receivedOn: row.receivedOn,
      sourceRef: row.sourceRef,
      sourceId,
      commitmentRef: row.commitmentRef,
      commitmentId,
      note: row.note,
      txHash: row.txHash,
      outputIndex: row.outputIndex,
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
    importable.every((row) => row.dedupeKey !== null);

  return {
    tickers,
    sources,
    commitments,
    availableSources: [...ctx.sources],
    availableCommitments: [...ctx.commitments],
    defaultSourceId: defaultSource?.id ?? null,
    defaultCommitmentId: defaultCommitment?.id ?? null,
    rows,
    issues,
    counts: {
      lines: parsed.lineCount,
      new: rows.filter((r) => r.status === "new").length,
      duplicates: rows.filter((r) => r.status === "duplicate").length,
      fileDuplicates: rows.filter((r) => r.duplicateOfLine !== null).length,
      invalid: invalidLines.size,
    },
    totals: receiptTotals(importable, tickers),
    ready,
  };
}

function willImport(row: PlannedReceiptRow, includeDuplicates: boolean): boolean {
  return row.status === "new" || (row.status === "duplicate" && includeDuplicates);
}

function receiptTotals(rows: readonly PlannedReceiptRow[], tickers: readonly TickerResolution[]): LegacyTotal[] {
  const info = new Map<string, { ticker: string; decimals: number }>();
  for (const t of tickers) if (t.status === "resolved") info.set(t.unit, { ticker: t.ticker, decimals: t.decimals });
  const sums = new Map<string, bigint>();
  for (const row of rows) {
    for (const a of row.amounts) {
      if (a.unit === null || a.quantity === null) continue;
      addQuantity(sums, a.unit, BigInt(a.quantity));
    }
  }
  return [...sums].map(([unit, amount]) => {
    const token = info.get(unit) ?? { ticker: unit, decimals: 0 };
    return { workgroupId: null, unit, ticker: token.ticker, decimals: token.decimals, amount: amount.toString() };
  });
}

export function legacyReceiptRpcRows(
  plan: LegacyReceiptImportPlan,
  includeDuplicates: boolean,
): LegacyReceiptRpcRow[] {
  if (!plan.ready) return [];
  return plan.rows.filter((row) => willImport(row, includeDuplicates)).map((row) => ({
    lineNo: row.line,
    receivedOn: row.receivedOn,
    fundingSourceId: row.sourceId,
    fundingCommitmentId: row.commitmentId,
    note: row.note,
    dedupeKey: row.dedupeKey!,
    txHash: row.txHash,
    outputIndex: row.outputIndex,
    amounts: row.amounts.map((a) => ({
      unit: a.unit!,
      ticker: a.unit === ADA_ASSET.unit ? ADA_ASSET.fieldName : a.ticker,
      decimals: a.decimals!,
      amount: a.quantity!,
    })),
  }));
}

export function legacyReceiptPlanHash(
  rows: readonly LegacyReceiptRpcRow[],
  hash: (canonical: string) => string,
): string {
  return hash(rows.map((r) => r.dedupeKey).sort().join("\n"));
}

export function previewReceiptRows(
  plan: LegacyReceiptImportPlan,
  cleanLimit = 100,
): { rows: PlannedReceiptRow[]; truncated: boolean } {
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
