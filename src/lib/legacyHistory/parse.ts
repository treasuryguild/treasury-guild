// Read a payment-history CSV into typed rows and issues. Columns: userId,
// task, date and workgroup (any case, spaces and underscores ignored), and
// one column per token ticker whose cells are amounts in display units.
// Pure; the planner resolves tickers and workgroups afterwards.
import {
  LEGACY_MAX_ROWS, LEGACY_MAX_TASK_CHARS, LEGACY_MAX_TICKERS, LegacyIssueCode as Code,
} from "@/lib/constants";
import { parseCsv, parseCsvAmount, parseCsvDate } from "@/lib/csv";
import type { LegacyIssue, ParsedAmount, ParsedHistory, ParsedHistoryRow } from "./types";

const REQUIRED = ["userid", "task", "date", "workgroup"] as const;
type RequiredColumn = (typeof REQUIRED)[number];

/** Workgroup names are compared (and aliased) up to one metadatum, like the chain import. */
export const MAX_WORKGROUP_REF_BYTES = 64;
/** Cardano went live in 2017: an earlier date is a typo. */
const FIRST_YEAR = 2017;

const BECH32_TAIL_RE = /^[02-9ac-hj-np-z]{6,128}$/;
const ADDRESS_RE = /^addr(_test)?1[02-9ac-hj-np-z]{10,190}$/;
const TICKER_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$/;

function headerKey(cell: string): string {
  return cell.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

export function isTickerHeader(cell: string): boolean {
  return TICKER_RE.test(cell);
}

/** "Governance Workgroup" / "governance_workgroup" → "governance-workgroup". */
export function normalizeWorkgroupName(name: string): string {
  return name.trim().toLowerCase().replace(/[\s_]+/g, "-").replace(/-{2,}/g, "-").replace(/^-+|-+$/g, "");
}

/** The receiver's address end (at least 6 bech32 characters) or a whole address, lowercased; null when neither. */
export function normalizeRecipientRef(raw: string): string | null {
  const ref = raw.trim().toLowerCase();
  return ADDRESS_RE.test(ref) || BECH32_TAIL_RE.test(ref) ? ref : null;
}

/** A payment date: `parseCsvDate`, from 2017 (Cardano's launch) on; earlier is a typo. */
export function parseHistoryDate(raw: string): string | null {
  const day = parseCsvDate(raw);
  return day !== null && day.slice(0, 4) >= String(FIRST_YEAR) ? day : null;
}

export type AmountCell =
  | { kind: "none" }
  | { kind: "amount"; value: string }
  | { kind: "error"; code: typeof Code.BadAmount | typeof Code.AmountComma };

/** One ticker cell (`parseCsvAmount`), with the history import's issue codes. */
export function parseAmountCell(raw: string): AmountCell {
  const cell = parseCsvAmount(raw);
  if (cell.kind !== "error") return cell;
  return { kind: "error", code: cell.reason === "comma" ? Code.AmountComma : Code.BadAmount };
}

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;

/** `latestDate` ("YYYY-MM-DD"): the last date a payment can carry (a later one is a typo). */
export function readHistoryCsv(text: string, latestDate: string): ParsedHistory {
  const issues: LegacyIssue[] = [];
  const fileIssue = (code: LegacyIssue["code"], extra: Partial<LegacyIssue> = {}) =>
    issues.push({ code, line: null, severity: "error", ...extra });
  const empty: ParsedHistory = { tickers: [], rows: [], lineCount: 0, issues };

  const { records, unterminatedQuoteLine } = parseCsv(text);
  if (unterminatedQuoteLine !== null) {
    issues.push({ code: Code.UnterminatedQuote, line: unterminatedQuoteLine, severity: "error" });
    return empty;
  }
  // Spreadsheet exports end with rows of bare commas: not data.
  const nonBlank = records.filter((r) => r.fields.some((f) => f.trim() !== ""));
  const [header, ...data] = nonBlank;
  if (!header || data.length === 0) {
    fileIssue(Code.EmptyFile);
    return empty;
  }

  const columns = new Map<RequiredColumn, number>();
  const tickerColumns: { index: number; ticker: string }[] = [];
  const seen = new Set<string>();
  let headerOk = true;
  header.fields.forEach((cell, index) => {
    const key = headerKey(cell);
    if (key === "") {
      // A trailing unnamed column only matters when it has values.
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
    if ((REQUIRED as readonly string[]).includes(key)) {
      columns.set(key as RequiredColumn, index);
    } else if (isTickerHeader(cell.trim())) {
      tickerColumns.push({ index, ticker: cell.trim() });
    } else {
      fileIssue(Code.BadTickerColumn, { column: cell.trim() });
      headerOk = false;
    }
  });
  for (const name of REQUIRED) {
    if (!columns.has(name)) {
      fileIssue(Code.MissingColumn, { column: name === "userid" ? "userId" : name });
      headerOk = false;
    }
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

  const rows: ParsedHistoryRow[] = [];
  for (const record of data) {
    const line = record.line;
    const lineIssue = (code: LegacyIssue["code"], extra: Partial<LegacyIssue> = {}) =>
      issues.push({ code, line, severity: "error", ...extra });
    const before = issues.length;
    const cell = (name: RequiredColumn) => record.fields[columns.get(name)!] ?? "";

    // More values than columns: most often a comma in an unquoted task.
    if (record.fields.slice(header.fields.length).some((f) => f.trim() !== "")) {
      lineIssue(Code.FieldCount, { value: String(record.fields.length) });
    }

    const recipientRef = normalizeRecipientRef(cell("userid"));
    if (!recipientRef) lineIssue(Code.BadRecipient, { value: cell("userid").trim() });

    const task = cell("task").trim();
    if (task === "") lineIssue(Code.EmptyTask);
    else if ([...task].length > LEGACY_MAX_TASK_CHARS) lineIssue(Code.TaskTooLong);

    const paidOn = parseHistoryDate(cell("date"));
    if (!paidOn) lineIssue(Code.BadDate, { value: cell("date").trim() });
    else if (paidOn > latestDate) lineIssue(Code.FutureDate, { value: cell("date").trim() });

    const workgroupName = cell("workgroup").trim();
    const workgroupRef = normalizeWorkgroupName(workgroupName);
    if (workgroupRef === "") lineIssue(Code.EmptyWorkgroup);
    else if (utf8Bytes(workgroupRef) > MAX_WORKGROUP_REF_BYTES) lineIssue(Code.WorkgroupTooLong);

    const amounts: ParsedAmount[] = [];
    for (const { index, ticker } of tickerColumns) {
      const raw = record.fields[index] ?? "";
      const parsed = parseAmountCell(raw);
      if (parsed.kind === "amount") amounts.push({ ticker, raw: parsed.value });
      else if (parsed.kind === "error") lineIssue(parsed.code, { column: ticker, value: raw.trim() });
    }
    if (amounts.length === 0 && !issues.slice(before).some((i) => i.column)) lineIssue(Code.NoAmount);

    if (issues.length === before) {
      rows.push({ line, recipientRef: recipientRef!, task, paidOn: paidOn!, workgroupRef, workgroupName, amounts });
    }
  }
  return { tickers, rows, lineCount: data.length, issues };
}
