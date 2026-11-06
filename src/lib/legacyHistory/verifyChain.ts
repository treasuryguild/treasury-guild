// Fetch Koios tx_info for the hashes named in a plan and apply chainMatch.
import "server-only";

import { LEGACY_MAX_DISTINCT_TX, LegacyIssueCode as Code } from "@/lib/constants";
import { txInfoBulk } from "@/lib/cardano/koios";
import type { Network } from "@/lib/config";
import { errorMessage, UpstreamError } from "@/lib/errors";
import {
  chainTxFromKoios, groupKey, matchPaymentClaims, matchReceiptClaims, type ChainTxInfo,
} from "./chainMatch";
import { isFullShelleyAddress } from "./parse";
import { canonicalRow, legacyImportableTotals } from "./plan";
import type { LegacyImportPlan, LegacyIssue, PlannedRow } from "./types";
import type { LegacyReceiptImportPlan, PlannedReceiptRow } from "./receiptTypes";

function willImportStatus(status: "new" | "duplicate" | "invalid", includeDuplicates: boolean): boolean {
  return status === "new" || (status === "duplicate" && includeDuplicates);
}

export async function applyPaymentChainChecks(
  plan: LegacyImportPlan,
  args: {
    network: Network;
    previousWalletAddress: string | null;
    alreadyClaimed: Map<string, Record<string, string>>;
    includeDuplicates: boolean;
    existingKeys: ReadonlySet<string>;
    hash: (canonical: string) => string;
  },
): Promise<LegacyImportPlan> {
  const issues: LegacyIssue[] = [...plan.issues];
  if (!args.previousWalletAddress) {
    issues.push({ code: Code.BadRecipient, line: null, severity: "error", value: "previous wallet address required" });
    return { ...plan, issues, ready: false };
  }

  const importable = plan.rows.filter((r) => willImportStatus(r.status, args.includeDuplicates) && r.status !== "invalid");
  const hashes = [...new Set(importable.map((r) => r.txHash))];
  if (hashes.length > LEGACY_MAX_DISTINCT_TX) {
    issues.push({ code: Code.TooManyDistinctTx, line: null, severity: "error", value: String(hashes.length) });
    return withPaymentIssues(plan, issues, { includeDuplicates: args.includeDuplicates });
  }

  let txs = new Map<string, ChainTxInfo>();
  if (hashes.length > 0) {
    try {
      const infos = await txInfoBulk(args.network, hashes);
      txs = new Map(infos.map((info) => {
        const tx = chainTxFromKoios(info);
        return [tx.txHash, tx] as const;
      }));
    } catch (err) {
      throw new UpstreamError(`Could not look up transactions: ${errorMessage(err, "chain provider error")}`);
    }
  }

  const { issues: chainIssues, resolvedRecipients } = matchPaymentClaims(
    args.previousWalletAddress,
    importable.map((r) => ({
      line: r.line,
      txHash: r.txHash,
      outputIndex: r.outputIndex,
      recipientAddress: r.recipientRef,
      amounts: r.amounts
        .filter((a) => a.unit && a.quantity)
        .map((a) => ({ unit: a.unit!, quantity: a.quantity! })),
      taskNormalized: r.task.replace(/\s+/g, " ").trim().toLowerCase(),
    })),
    txs,
    args.alreadyClaimed,
  );
  issues.push(...chainIssues);
  return withPaymentIssues(plan, issues, {
    includeDuplicates: args.includeDuplicates,
    resolvedRecipients,
    existingKeys: args.existingKeys,
    hash: args.hash,
  });
}

export async function applyReceiptChainChecks(
  plan: LegacyReceiptImportPlan,
  args: {
    network: Network;
    previousWalletAddress: string | null;
    alreadyClaimed: Map<string, Record<string, string>>;
    includeDuplicates: boolean;
  },
): Promise<LegacyReceiptImportPlan> {
  const issues: LegacyIssue[] = [...plan.issues];
  if (!args.previousWalletAddress) {
    issues.push({ code: Code.BadRecipient, line: null, severity: "error", value: "previous wallet address required" });
    return { ...plan, issues, ready: false };
  }

  const importable = plan.rows.filter((r) => willImportStatus(r.status, args.includeDuplicates) && r.status !== "invalid");
  const hashes = [...new Set(importable.map((r) => r.txHash))];
  if (hashes.length > LEGACY_MAX_DISTINCT_TX) {
    issues.push({ code: Code.TooManyDistinctTx, line: null, severity: "error", value: String(hashes.length) });
    return withReceiptIssues(plan, issues, importable);
  }

  let txs = new Map<string, ChainTxInfo>();
  if (hashes.length > 0) {
    try {
      const infos = await txInfoBulk(args.network, hashes);
      txs = new Map(infos.map((info) => {
        const tx = chainTxFromKoios(info);
        return [tx.txHash, tx] as const;
      }));
    } catch (err) {
      throw new UpstreamError(`Could not look up transactions: ${errorMessage(err, "chain provider error")}`);
    }
  }

  const chainIssues = matchReceiptClaims(
    args.previousWalletAddress,
    importable.map((r) => ({
      line: r.line,
      txHash: r.txHash,
      outputIndex: r.outputIndex,
      amounts: r.amounts
        .filter((a) => a.unit && a.quantity)
        .map((a) => ({ unit: a.unit!, quantity: a.quantity! })),
      csvDay: r.receivedOn,
    })),
    txs,
    args.alreadyClaimed,
  );
  issues.push(...chainIssues);
  return withReceiptIssues(plan, issues, importable);
}

function withPaymentIssues(
  plan: LegacyImportPlan,
  issues: LegacyIssue[],
  opts: {
    includeDuplicates: boolean;
    resolvedRecipients?: Map<number, string>;
    existingKeys?: ReadonlySet<string>;
    hash?: (canonical: string) => string;
  },
): LegacyImportPlan {
  const badLines = new Set(issues.filter((i) => i.severity === "error" && i.line !== null).map((i) => i.line!));
  const resolved = opts.resolvedRecipients ?? new Map<number, string>();
  const existingKeys = opts.existingKeys ?? new Set<string>();
  const hash = opts.hash;

  const rows: PlannedRow[] = plan.rows.map((r) => {
    if (badLines.has(r.line)) return { ...r, status: "invalid" as const };
    const full = resolved.get(r.line);
    if (!full || !hash) return r;
    const amounts = r.amounts
      .filter((a) => a.unit && a.quantity)
      .map((a) => ({ unit: a.unit!, quantity: a.quantity! }));
    const dedupeKey = hash(canonicalRow({
      recipientRef: full,
      workgroupRef: r.workgroupRef,
      paidOn: r.paidOn,
      task: r.task,
      txHash: r.txHash,
      outputIndex: r.outputIndex,
      amounts,
    }));
    return {
      ...r,
      recipientRef: full,
      dedupeKey,
      status: existingKeys.has(dedupeKey) ? "duplicate" as const : "new" as const,
    };
  });

  const still = rows.filter((r) => willImportStatus(r.status, opts.includeDuplicates) && r.status !== "invalid");
  const ready = !issues.some((i) => i.severity === "error") && still.length > 0 &&
    still.every((row) =>
      row.workgroupId !== null &&
      row.dedupeKey !== null &&
      isFullShelleyAddress(row.recipientRef));

  const next: LegacyImportPlan = {
    ...plan,
    rows,
    issues,
    counts: {
      ...plan.counts,
      new: rows.filter((r) => r.status === "new").length,
      duplicates: rows.filter((r) => r.status === "duplicate").length,
      invalid: new Set([...badLines, ...rows.filter((r) => r.status === "invalid").map((r) => r.line)]).size,
    },
    ready,
  };
  return { ...next, totals: legacyImportableTotals(next, opts.includeDuplicates) };
}

function withReceiptIssues(
  plan: LegacyReceiptImportPlan,
  issues: LegacyIssue[],
  importable: PlannedReceiptRow[] = plan.rows,
): LegacyReceiptImportPlan {
  const badLines = new Set(issues.filter((i) => i.severity === "error" && i.line !== null).map((i) => i.line!));
  const rows = plan.rows.map((r) => (badLines.has(r.line) ? { ...r, status: "invalid" as const } : r));
  const still = importable.filter((r) => !badLines.has(r.line));
  const ready = !issues.some((i) => i.severity === "error") && still.length > 0 &&
    still.every((row) => row.dedupeKey !== null);
  return {
    ...plan,
    rows,
    issues,
    counts: {
      ...plan.counts,
      invalid: new Set([...badLines, ...plan.rows.filter((r) => r.status === "invalid").map((r) => r.line)]).size,
    },
    ready,
  };
}

export { groupKey };
