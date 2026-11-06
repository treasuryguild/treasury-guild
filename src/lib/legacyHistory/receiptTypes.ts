// Shapes of a previous-wallet receipts upload. Client-safe: the preview renders them.
import type { LegacyIssue, LegacyToken, LegacyTotal, PlannedAmount, TickerResolution } from "./types";

export interface ParsedReceiptRow {
  line: number;
  /** "YYYY-MM-DD". */
  receivedOn: string;
  /** Normalized funding source name; empty when the cell was blank. */
  sourceRef: string;
  /** The source cell as written (trimmed). */
  sourceName: string;
  /** Normalized commitment name; empty when blank. */
  commitmentRef: string;
  commitmentName: string;
  note: string | null;
  txHash: string;
  /** Null when the CSV omitted it; chain match fills a unique matching output. */
  outputIndex: number | null;
  amounts: { ticker: string; raw: string }[];
}

export interface ParsedReceipts {
  tickers: string[];
  rows: ParsedReceiptRow[];
  lineCount: number;
  issues: LegacyIssue[];
}

export interface FundingSourceRef {
  id: string;
  name: string;
}

export interface FundingCommitmentRef {
  id: string;
  sourceId: string;
  name: string;
}

export type SourceResolution =
  | { ref: string; name: string; status: "resolved"; source: FundingSourceRef }
  | { ref: string; name: string; status: "ambiguous"; candidates: FundingSourceRef[] }
  | { ref: string; name: string; status: "missing" }
  /** Blank source cell: allowed (untagged income on the Dashboard). */
  | { ref: ""; name: ""; status: "none" };

export type CommitmentResolution =
  | { ref: string; name: string; status: "resolved"; commitment: FundingCommitmentRef }
  | { ref: string; name: string; status: "ambiguous"; candidates: FundingCommitmentRef[] }
  | { ref: string; name: string; status: "missing" }
  | { ref: ""; name: ""; status: "none" };

export type PlannedReceiptStatus = "new" | "duplicate" | "invalid";

export interface PlannedReceiptRow {
  line: number;
  receivedOn: string;
  sourceRef: string;
  sourceId: string | null;
  commitmentRef: string;
  commitmentId: string | null;
  note: string | null;
  txHash: string;
  /** Null until chain match resolves a unique (or named) output. */
  outputIndex: number | null;
  amounts: PlannedAmount[];
  dedupeKey: string | null;
  status: PlannedReceiptStatus;
  duplicateOfLine: number | null;
}

export interface LegacyReceiptImportPlan {
  tickers: TickerResolution[];
  sources: SourceResolution[];
  commitments: CommitmentResolution[];
  /** Community funding sources, for tagging blank-source rows in the preview. */
  availableSources: FundingSourceRef[];
  availableCommitments: FundingCommitmentRef[];
  /** Applied to blank-source rows; null when not set. */
  defaultSourceId: string | null;
  defaultCommitmentId: string | null;
  rows: PlannedReceiptRow[];
  issues: LegacyIssue[];
  counts: { lines: number; new: number; duplicates: number; fileDuplicates: number; invalid: number };
  totals: LegacyTotal[];
  ready: boolean;
}

/** One element of stage/activate legacy receipts p_rows. */
export interface LegacyReceiptRpcRow {
  lineNo: number;
  receivedOn: string;
  fundingSourceId: string | null;
  fundingCommitmentId: string | null;
  note: string | null;
  dedupeKey: string;
  txHash: string;
  outputIndex: number;
  amounts: { unit: string; ticker: string; decimals: number; amount: string }[];
}

export type { LegacyIssue, LegacyToken, LegacyTotal, TickerResolution };
