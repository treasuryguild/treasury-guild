// Shapes of the chain import: what blocks a transaction (stored in
// external_txs.import_issues and shown to admins) and the plan the
// import_chain_tx RPC executes (migration 0045). Client-safe.

import type { ChainImportIssueCode, TxKind } from "@/lib/constants";

type Code = typeof ChainImportIssueCode;

/** One reason a transaction is held, with what the queue needs to explain it. */
export type ChainImportIssue =
  | { code: Code["UnsupportedVersion"]; version: string }
  | { code: Code["BadMetadata"]; detail: string }
  | { code: Code["SlugMismatch"]; slug: string }
  | { code: Code["WorkgroupMissing"]; name: string }
  | { code: Code["WorkgroupAmbiguous"]; name: string }
  | { code: Code["WorkgroupArchived"]; name: string }
  | { code: Code["UnknownTicker"]; ticker: string }
  | {
      code: Code["NumberConflict"];
      chainNumber: number;
      existing: { id: string; title: string; payState: string; paidTxHash: string | null };
      reason: string;
    }
  | { code: Code["AmountMismatch"]; outputIndex: number; detail: string }
  | { code: Code["OutputMissing"]; outputIndex: number }
  | { code: Code["UnknownTreasury"]; outputIndex: number; address: string }
  | { code: Code["TransferMismatch"]; outputIndex: number; address: string }
  | { code: Code["MissingCbor"] }
  | { code: Code["HashMismatch"] }
  | { code: Code["ImportFailed"]; detail: string };

/** How a task named by the metadata lands in this database. */
export const ImportTaskMode = {
  /** The chain number is free: create the task under it. */
  Keep: "keep",
  /** An admin's choice on a conflict: create it under the next free number. */
  New: "new",
  /** A matching unpaid task already exists: mark that one paid. */
  Settle: "settle",
} as const;
export type ImportTaskMode = (typeof ImportTaskMode)[keyof typeof ImportTaskMode];

export interface ImportPlanTask {
  chainNumber: number;
  mode: ImportTaskMode;
  /** The existing task, for `settle`. */
  taskId: string | null;
  workgroupId: string;
  title: string;
  /** Ticker → exact decimal string, as written on-chain. */
  amounts: Record<string, string>;
  bountyLovelace: string | null;
  /** "YYYY-MM-DD", day 1. */
  budgetMonth: string;
  /** Recipient wallets in output order: one 'manual' assignee each. */
  wallets: string[];
}

/** Base-unit amounts travel as strings (bigint does not survive JSON). */
export interface ImportPlanPayout {
  chainNumber: number;
  wallet: string;
  unit: string;
  amount: string;
}

export interface ImportPlanPayment {
  recipientWallet: string;
  recipientTreasuryId: string | null;
  label: string | null;
  unit: string;
  amount: string;
  /** Null exactly when the output is a transfer. */
  budgetMonth: string | null;
}

/** The part of the plan the metadata and outputs decide. */
export interface ChainImportRows {
  kind: typeof TxKind.Payout | typeof TxKind.Payment;
  description: string;
  contributors: string[];
  /** Tickers resolved from the transaction's own outputs, new to the registry. */
  assets: { fieldName: string; unit: string; decimals: number }[];
  tasks: ImportPlanTask[];
  payouts: ImportPlanPayout[];
  payments: ImportPlanPayment[];
}

/** `p_plan` of import_chain_tx. */
export interface ChainImportPlan extends ChainImportRows {
  treasuryId: string;
  txCbor: string;
  signedAddresses: string[];
  createdBy: string;
  /** ISO timestamp of the block. */
  blockTime: string;
}

export type ChainImportPlanResult =
  | { ok: true; rows: ChainImportRows }
  | { ok: false; issues: ChainImportIssue[] };
