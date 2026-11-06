// Fetch Koios tx_info for the hashes named in a plan and apply chainMatch.
import "server-only";

import { LEGACY_MAX_DISTINCT_TX, LegacyIssueCode as Code } from "@/lib/constants";
import { txInfoBulk } from "@/lib/cardano/koios";
import type { Network } from "@/lib/config";
import { errorMessage, UpstreamError } from "@/lib/errors";
import {
  chainTxFromKoios, groupKey, matchPaymentClaims, matchReceiptClaims, type ChainTxInfo,
} from "./chainMatch";
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
    return withPaymentIssues(plan, issues);
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

  const chainIssues = matchPaymentClaims(
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
  return withPaymentIssues(plan, issues, importable);
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
    return withReceiptIssues(plan, issues);
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
  importable: PlannedRow[] = plan.rows,
): LegacyImportPlan {
  const badLines = new Set(issues.filter((i) => i.severity === "error" && i.line !== null).map((i) => i.line!));
  const rows = plan.rows.map((r) => (badLines.has(r.line) ? { ...r, status: "invalid" as const } : r));
  const still = importable.filter((r) => !badLines.has(r.line));
  const ready = !issues.some((i) => i.severity === "error") && still.length > 0 &&
    still.every((row) => row.workgroupId !== null && row.dedupeKey !== null);
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
