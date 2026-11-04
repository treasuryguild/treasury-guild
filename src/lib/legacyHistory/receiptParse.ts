// Read a previous-wallet receipts CSV into typed rows and issues. Columns:
// date (required), optional source / commitment / note, and one column per
// token ticker. Pure; the planner resolves tickers and funding names afterwards.
import {
  LEGACY_MAX_NOTE_CHARS, LEGACY_MAX_ROWS, LEGACY_MAX_TICKERS, LegacyIssueCode as Code,
} from "@/lib/constants";
import { parseCsv } from "@/lib/csv";
import { isTickerHeader, parseAmountCell, parseHistoryDate } from "./parse";
import type { LegacyIssue } from "./types";
import type { ParsedReceiptRow, ParsedReceipts } from "./receiptTypes";

const META = ["date", "source", "commitment", "note"] as const;
type MetaColumn = (typeof META)[number];

function headerKey(cell: string): string {
  return cell.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

/** Funding source / commitment names compared case-insensitively with collapsed spaces. */
export function normalizeFundingName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

export function readReceiptsCsv(text: string, latestDate: string): ParsedReceipts {
  const issues: LegacyIssue[] = [];
  const fileIssue = (code: LegacyIssue["code"], extra: Partial<LegacyIssue> = {}) =>
    issues.push({ code, line: null, severity: "error", ...extra });
  const empty: ParsedReceipts = { tickers: [], rows: [], lineCount: 0, issues };

  const { records, unterminatedQuoteLine } = parseCsv(text);
  if (unterminatedQuoteLine !== null) {
    issues.push({ code: Code.UnterminatedQuote, line: unterminatedQuoteLine, severity: "error" });
    return empty;
  }
  const nonBlank = records.filter((r) => r.fields.some((f) => f.trim() !== ""));
  const [header, ...data] = nonBlank;
  if (!header || data.length === 0) {
    fileIssue(Code.EmptyFile);
    return empty;
  }

  const columns = new Map<MetaColumn, number>();
  const tickerColumns: { index: number; ticker: string }[] = [];
  const seen = new Set<string>();
  let headerOk = true;
  header.fields.forEach((cell, index) => {
    const key = headerKey(cell);
    if (key === "") {
      if (data.some((row) => (row.fields[index] ?? "").trim() !== "")) {
        fileIssue(Code.UnnamedColumn, { value: String(index + 1) });
        headerOk = false;
      }
      return;
    }
    if (seen.has(key)) {
      fileIssue(Code.DuplicateColumn, { column: cell.trim() });
      headerOk = false;
      return;
    }
    seen.add(key);
    if ((META as readonly string[]).includes(key)) {
      columns.set(key as MetaColumn, index);
    } else if (isTickerHeader(cell.trim())) {
      tickerColumns.push({ index, ticker: cell.trim() });
    } else {
      fileIssue(Code.BadTickerColumn, { column: cell.trim() });
      headerOk = false;
    }
  });
  if (!columns.has("date")) {
    fileIssue(Code.MissingColumn, { column: "date" });
    headerOk = false;
  }
  if (tickerColumns.length === 0) {
    fileIssue(Code.NoTickerColumns);
    headerOk = false;
  } else if (tickerColumns.length > LEGACY_MAX_TICKERS) {
    fileIssue(Code.TooManyTickers, { value: String(tickerColumns.length) });
    headerOk = false;
  }
  if (data.length > LEGACY_MAX_ROWS) {
    fileIssue(Code.TooManyRows, { value: String(data.length) });
    headerOk = false;
  }
  const tickers = tickerColumns.map((c) => c.ticker);
  if (!headerOk) return { tickers, rows: [], lineCount: data.length, issues };

  const rows: ParsedReceiptRow[] = [];
  for (const record of data) {
    const line = record.line;
    const lineIssue = (code: LegacyIssue["code"], extra: Partial<LegacyIssue> = {}) =>
      issues.push({ code, line, severity: "error", ...extra });
    const before = issues.length;
    const cell = (name: MetaColumn) =>
      columns.has(name) ? (record.fields[columns.get(name)!] ?? "") : "";

    if (record.fields.slice(header.fields.length).some((f) => f.trim() !== "")) {
      lineIssue(Code.FieldCount, { value: String(record.fields.length) });
    }

    const receivedOn = parseHistoryDate(cell("date"));
    if (!receivedOn) lineIssue(Code.BadDate, { value: cell("date").trim() });
    else if (receivedOn > latestDate) lineIssue(Code.FutureDate, { value: cell("date").trim() });

    const sourceName = cell("source").trim();
    const sourceRef = sourceName === "" ? "" : normalizeFundingName(sourceName);
    const commitmentName = cell("commitment").trim();
    const commitmentRef = commitmentName === "" ? "" : normalizeFundingName(commitmentName);
    if (commitmentRef !== "" && sourceRef === "") {
      lineIssue(Code.CommitmentWithoutSource, { value: commitmentName });
    }

    const noteRaw = cell("note").trim();
    let note: string | null = noteRaw === "" ? null : noteRaw;
    if (note !== null && [...note].length > LEGACY_MAX_NOTE_CHARS) {
      lineIssue(Code.NoteTooLong);
      note = null;
    }

    const amounts: ParsedReceiptRow["amounts"] = [];
    for (const { index, ticker } of tickerColumns) {
      const raw = record.fields[index] ?? "";
      const parsed = parseAmountCell(raw);
      if (parsed.kind === "amount") amounts.push({ ticker, raw: parsed.value });
      else if (parsed.kind === "error") lineIssue(parsed.code, { column: ticker, value: raw.trim() });
    }
    if (amounts.length === 0 && !issues.slice(before).some((i) => i.column)) lineIssue(Code.NoAmount);

    if (issues.length === before) {
      rows.push({
        line,
        receivedOn: receivedOn!,
        sourceRef,
        sourceName,
        commitmentRef,
        commitmentName,
        note,
        amounts,
      });
    }
  }
  return { tickers, rows, lineCount: data.length, issues };
}
