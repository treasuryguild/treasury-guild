// Shapes of a payment-history upload, from parsed CSV to the rows
// import_legacy_history writes. Client-safe: the preview renders them.
import type { LegacyIssueCode } from "@/lib/constants";

export interface LegacyIssue {
  code: LegacyIssueCode;
  /** CSV line (header = 1), or null for the whole file. */
  line: number | null;
  severity: "error" | "warning";
  /** The column (ticker) the issue is about. */
  column?: string;
  /** The offending value, or the other line of a duplicate. */
  value?: string;
}

export interface ParsedAmount {
  ticker: string;
  /** The display-unit decimal as written, e.g. "480.5". */
  raw: string;
}

/** A CSV line that parsed; a line with an error issue is absent. */
export interface ParsedHistoryRow {
  line: number;
  /** Lowercased end of the receiver's address (or the whole address). */
  recipientRef: string;
  task: string;
  /** "YYYY-MM-DD". */
  paidOn: string;
  /** Normalized workgroup name: what matching and the duplicate key use. */
  workgroupRef: string;
  /** The workgroup cell as written (trimmed), offered as the name to create. */
  workgroupName: string;
  amounts: ParsedAmount[];
}

export interface ParsedHistory {
  /** Ticker columns in file order. */
  tickers: string[];
  rows: ParsedHistoryRow[];
  /** Data lines in the file (blank lines excluded). */
  lineCount: number;
  issues: LegacyIssue[];
}

export interface LegacyToken {
  unit: string;
  ticker: string;
  decimals: number;
}

export type TickerSource = "ada" | "registry" | "manual" | "history" | "wallet";

export type TickerResolution =
  | { ticker: string; status: "resolved"; unit: string; decimals: number; source: TickerSource }
  | { ticker: string; status: "ambiguous"; candidates: LegacyToken[] }
  /** No token found; `manualUnit` is set when the admin's unit is not a known asset. */
  | { ticker: string; status: "unknown"; manualUnit?: string };

export interface LegacyWorkgroup {
  id: string;
  name: string;
  archived: boolean;
}

export type WorkgroupResolution =
  | { ref: string; name: string; status: "resolved"; workgroup: LegacyWorkgroup }
  | { ref: string; name: string; status: "ambiguous"; candidates: LegacyWorkgroup[] }
  | { ref: string; name: string; status: "missing" };

export interface PlannedAmount {
  ticker: string;
  raw: string;
  /** Null while the ticker is unresolved. */
  unit: string | null;
  decimals: number | null;
  /** Base units; null while unresolved or unscalable. */
  quantity: string | null;
}

export type PlannedRowStatus = "new" | "duplicate" | "invalid";

export interface PlannedRow {
  line: number;
  recipientRef: string;
  task: string;
  paidOn: string;
  /** "YYYY-MM-01", the budget period's first month; null without a workgroup. */
  budgetMonth: string | null;
  workgroupRef: string;
  workgroupId: string | null;
  amounts: PlannedAmount[];
  /** sha256 of the canonical row; null until every part resolved. */
  dedupeKey: string | null;
  /** `duplicate` = already imported for this wallet. */
  status: PlannedRowStatus;
  /** An earlier line of this file with the same content. */
  duplicateOfLine: number | null;
}

export interface LegacyTotal {
  /** Null = every workgroup. */
  workgroupId: string | null;
  unit: string;
  ticker: string;
  decimals: number;
  /** Base units. */
  amount: string;
}

export interface LegacyImportPlan {
  tickers: TickerResolution[];
  workgroups: WorkgroupResolution[];
  rows: PlannedRow[];
  issues: LegacyIssue[];
  counts: { lines: number; new: number; duplicates: number; fileDuplicates: number; invalid: number };
  /** What an import would add: per workgroup, then overall (workgroupId null). */
  totals: LegacyTotal[];
  /** No error, every ticker and workgroup resolved, and something to import. */
  ready: boolean;
}

/** One element of import_legacy_history's p_rows. */
export interface LegacyRpcRow {
  lineNo: number;
  workgroupId: string;
  workgroupRef: string;
  recipientRef: string;
  task: string;
  paidOn: string;
  budgetMonth: string;
  dedupeKey: string;
  amounts: { unit: string; ticker: string; decimals: number; amount: string }[];
}
