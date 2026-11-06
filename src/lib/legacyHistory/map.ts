// Turn a CSV that is not in Treasury Guild's payment-history shape into one
// that is, by naming which column is which. The cells are copied as read:
// nothing here rewrites an amount, a date or an address. Pure.
import { parseCsv, parseCsvDate } from "@/lib/csv";
import { LEGACY_MAX_CSV_CHARS, LEGACY_MAX_TICKERS } from "@/lib/constants";
import { isTickerHeader, normalizeRecipientRef } from "./parse";

export interface HistoryAmountColumn {
  index: number;
  /** The ticker the canonical file will name this column. */
  ticker: string;
}

/** Which source column fills each field of the history CSV. Null is not yet chosen. */
export interface HistoryColumnMap {
  recipient: number | null;
  task: number | null;
  date: number | null;
  workgroup: number | null;
  txHash: number | null;
  outputIndex: number | null;
  amounts: HistoryAmountColumn[];
  skip: number[];
}

export interface HistoryQuestion {
  column: string | null;
  message: string;
}

export interface HistoryMapResult {
  headers: string[];
  /** Canonical CSV for `readHistoryCsv`, when every column is settled and every receiver is an address ending. */
  csv: string | null;
  questions: HistoryQuestion[];
  /** The map applied, or the best guess when the caller sent none. */
  suggested: HistoryColumnMap;
}

const ROLES = ["recipient", "task", "date", "workgroup", "txHash", "outputIndex"] as const;
type Role = (typeof ROLES)[number];

const ROLE_HEADERS: Record<Role, readonly string[]> = {
  recipient: ["userid", "user", "wallet", "address", "recipient", "payee", "receiver"],
  task: ["task", "description", "title", "what", "item"],
  date: ["date", "paid", "paidon", "paymentdate", "paiddate"],
  workgroup: ["workgroup", "group", "team"],
  txHash: ["txhash", "transactionhash", "txid", "hash"],
  outputIndex: ["outputindex", "output", "vout", "index"],
};

/** Headers that are people's names. Never treated as an address column or a ticker. */
const NAME_HEADERS = ["name", "recipientname", "payeename", "person", "contributor", "member"];

const ROLE_LABEL: Record<Role, string> = {
  recipient: "receiver (the end of their address)",
  task: "task",
  date: "date",
  workgroup: "workgroup",
  txHash: "transaction hash (64 hex characters)",
  outputIndex: "output index",
};

function headerKey(cell: string): string {
  return cell.trim().toLowerCase().replace(/[\s_-]+/g, "");
}

function quoteField(value: string): string {
  return /[",\r\n]/.test(value) ? `"${value.replaceAll('"', '""')}"` : value;
}

interface Table {
  headers: string[];
  rows: { line: number; cells: string[] }[];
  questions: HistoryQuestion[];
}

function readTable(text: string): Table {
  if (text.length > LEGACY_MAX_CSV_CHARS) {
    return {
      headers: [],
      rows: [],
      questions: [{ column: null, message: "The file is larger than 1 MB. Split it into several files." }],
    };
  }
  const { records, unterminatedQuoteLine } = parseCsv(text);
  if (unterminatedQuoteLine !== null) {
    return {
      headers: [],
      rows: [],
      questions: [{ column: null, message: `A quoted value opened on line ${unterminatedQuoteLine} is never closed.` }],
    };
  }
  const nonBlank = records.filter((r) => r.fields.some((f) => f.trim() !== ""));
  const [header, ...data] = nonBlank;
  if (!header || data.length === 0) {
    return {
      headers: [],
      rows: [],
      questions: [{ column: null, message: "The file needs a header row and at least one row of payments." }],
    };
  }
  const headers = header.fields.map((f, i) => f.trim() || `Column ${i + 1}`);
  return {
    headers,
    rows: data.map((r) => ({ line: r.line, cells: headers.map((_, i) => (r.fields[i] ?? "").trim()) })),
    questions: [],
  };
}

function nameQuestion(header: string, example: string): HistoryQuestion {
  const sample = example ? ` (for example "${example}")` : "";
  return {
    column: header,
    message: `Column "${header}"${sample} is not the end of a Cardano address. Payment history needs at least the last 6 characters of each receiver's address (or the whole address). Ask the user for those; do not invent them. Skip this column only when another column already has the addresses.`,
  };
}

function badRecipients(table: Table, index: number): string[] {
  const seen = new Set<string>();
  for (const row of table.rows) {
    const value = row.cells[index] ?? "";
    if (value !== "" && normalizeRecipientRef(value)) continue;
    if (!seen.has(value) && seen.size < 3) seen.add(value);
  }
  return [...seen];
}

/** A column whose every filled cell is a date, when the header did not say so. */
function dateByContents(table: Table, taken: ReadonlySet<number>): number | null {
  const hits = table.headers.map((_, i) => i).filter((i) => {
    if (taken.has(i)) return false;
    const filled = table.rows.map((r) => r.cells[i] ?? "").filter((c) => c !== "");
    return filled.length > 0 && filled.every((c) => parseCsvDate(c) !== null);
  });
  return hits.length === 1 ? hits[0]! : null;
}

function addressByContents(table: Table, taken: ReadonlySet<number>): number | null {
  const hits = table.headers.map((_, i) => i).filter((i) => {
    if (taken.has(i)) return false;
    const filled = table.rows.map((r) => r.cells[i] ?? "").filter((c) => c !== "");
    return filled.length > 0 && filled.every((c) => normalizeRecipientRef(c) !== null);
  });
  return hits.length === 1 ? hits[0]! : null;
}

function suggest(table: Table): { map: HistoryColumnMap; questions: HistoryQuestion[] } {
  const questions: HistoryQuestion[] = [];
  const buckets: Record<Role, number[]> = {
    recipient: [], task: [], date: [], workgroup: [], txHash: [], outputIndex: [],
  };
  const names: number[] = [];
  const amounts: HistoryAmountColumn[] = [];
  const other: number[] = [];

  table.headers.forEach((header, index) => {
    const key = headerKey(header);
    if (NAME_HEADERS.includes(key)) {
      names.push(index);
      return;
    }
    for (const role of ROLES) {
      if (ROLE_HEADERS[role].includes(key)) {
        buckets[role].push(index);
        return;
      }
    }
    if (isTickerHeader(header)) {
      amounts.push({ index, ticker: header });
      return;
    }
    const filled = table.rows.some((r) => (r.cells[index] ?? "") !== "");
    const unnamed = header.startsWith("Column ") && !table.rows.some((r) => (r.cells[index] ?? "") !== "");
    if (filled || !unnamed) other.push(index);
  });

  const map: HistoryColumnMap = {
    recipient: null, task: null, date: null, workgroup: null, txHash: null, outputIndex: null, amounts, skip: [],
  };
  for (const role of ROLES) {
    const hits = buckets[role];
    if (hits.length === 1) map[role] = hits[0]!;
    else if (hits.length > 1) {
      questions.push({
        column: null,
        message: `Which column is the ${ROLE_LABEL[role]}? ${hits.map((i) => table.headers[i]).join(", ")}.`,
      });
    }
  }
  const taken = new Set<number>([
    ...[map.recipient, map.task, map.date, map.workgroup, map.txHash, map.outputIndex].filter((i): i is number => i !== null),
    ...amounts.map((a) => a.index),
  ]);
  if (map.date === null) {
    const found = dateByContents(table, taken);
    if (found !== null) {
      map.date = found;
      taken.add(found);
    }
  }
  if (map.recipient === null) {
    const found = addressByContents(table, taken);
    if (found !== null) {
      map.recipient = found;
      taken.add(found);
    }
  }
  for (const role of ROLES) {
    // outputIndex is optional: chain match fills it when exactly one output matches.
    if (role === "outputIndex") continue;
    if (map[role] === null && !questions.some((q) => q.message.startsWith(`Which column is the ${ROLE_LABEL[role]}`))) {
      questions.push({ column: null, message: `Which column is the ${ROLE_LABEL[role]}? Columns: ${table.headers.join(", ")}.` });
    }
  }
  for (const index of names) {
    const example = table.rows.map((r) => r.cells[index] ?? "").find((c) => c !== "") ?? "";
    questions.push(nameQuestion(table.headers[index] ?? "", example));
  }
  for (const index of other) {
    if (taken.has(index) || names.includes(index)) continue;
    questions.push({
      column: table.headers[index] ?? null,
      message: `Column "${table.headers[index]}" is not mapped. Say which field it is, which token it pays, or that it should be skipped.`,
    });
  }
  if (amounts.length > LEGACY_MAX_TICKERS) {
    questions.push({ column: null, message: `The file has ${amounts.length} token columns; at most ${LEGACY_MAX_TICKERS} are allowed.` });
  }
  return { map, questions };
}

function validateMap(table: Table, map: HistoryColumnMap): HistoryQuestion[] {
  const questions: HistoryQuestion[] = [];
  const width = table.headers.length;
  const seen = new Map<number, string>();
  const claim = (index: number, label: string) => {
    if (index < 0 || index >= width) {
      questions.push({ column: null, message: `Column ${index + 1} is not in this file (${width} columns).` });
      return;
    }
    const earlier = seen.get(index);
    if (earlier !== undefined) {
      questions.push({ column: table.headers[index] ?? null, message: `Column "${table.headers[index]}" is mapped as both ${earlier} and ${label}.` });
    }
    seen.set(index, label);
  };
  for (const role of ROLES) {
    const index = map[role];
    if (index === null) {
      if (role !== "outputIndex") {
        questions.push({ column: null, message: `Which column is the ${ROLE_LABEL[role]}? Columns: ${table.headers.join(", ")}.` });
      }
    } else {
      claim(index, ROLE_LABEL[role]);
    }
  }
  for (const amount of map.amounts) {
    claim(amount.index, amount.ticker);
    if (!isTickerHeader(amount.ticker)) {
      questions.push({ column: amount.ticker, message: `"${amount.ticker}" is not a token ticker. Use the ticker, such as ADA, and ask the user which token it is when several share it.` });
    }
  }
  if (map.amounts.length === 0) {
    questions.push({ column: null, message: "Which columns are amounts, and which token ticker is each paid in? Skip a column that is another community's." });
  } else if (map.amounts.length > LEGACY_MAX_TICKERS) {
    questions.push({ column: null, message: `At most ${LEGACY_MAX_TICKERS} token columns can be imported.` });
  }
  const tickers = new Set<string>();
  for (const amount of map.amounts) {
    const key = amount.ticker.toLowerCase();
    if (tickers.has(key)) questions.push({ column: amount.ticker, message: `Two columns are both mapped to ${amount.ticker}. Map each token once.` });
    tickers.add(key);
  }
  for (const index of map.skip) claim(index, "skipped");
  for (let index = 0; index < width; index++) {
    if (seen.has(index)) continue;
    const header = table.headers[index] ?? "";
    const filled = table.rows.some((r) => (r.cells[index] ?? "") !== "");
    if (!filled && header.startsWith("Column ")) continue;
    if (NAME_HEADERS.includes(headerKey(header))) {
      const example = table.rows.map((r) => r.cells[index] ?? "").find((c) => c !== "") ?? "";
      questions.push(nameQuestion(header, example));
    } else {
      questions.push({
        column: header,
        message: `Column "${header}" is not mapped. Say which field it is, which token it pays, or that it should be skipped.`,
      });
    }
  }
  return questions;
}

function canonicalCsv(table: Table, map: HistoryColumnMap): string | null {
  const recipient = map.recipient!;
  const bad = badRecipients(table, recipient);
  if (bad.length > 0) return null;
  const withIndex = map.outputIndex !== null;
  const header = [
    "userId",
    ...map.amounts.map((a) => a.ticker),
    "task",
    "date",
    "workgroup",
    "txHash",
    ...(withIndex ? ["outputIndex"] as const : []),
  ];
  const lines = table.rows.map((row) => {
    const cells = [
      row.cells[recipient] ?? "",
      ...map.amounts.map((a) => row.cells[a.index] ?? ""),
      row.cells[map.task!] ?? "",
      row.cells[map.date!] ?? "",
      row.cells[map.workgroup!] ?? "",
      row.cells[map.txHash!] ?? "",
      ...(withIndex ? [row.cells[map.outputIndex!] ?? ""] : []),
    ];
    return cells.map(quoteField).join(",");
  });
  return [header.join(","), ...lines, ""].join("\n");
}

/**
 * Apply a column map, or guess one. `csv` is set only when every column is
 * accounted for and every receiver cell is an address or an address ending.
 * A name, a missing column or an unmapped column comes back as a question.
 */
export function applyHistoryColumnMap(text: string, map: HistoryColumnMap | null): HistoryMapResult {
  const table = readTable(text);
  if (table.questions.length > 0) {
    const empty: HistoryColumnMap = {
      recipient: null, task: null, date: null, workgroup: null, txHash: null, outputIndex: null, amounts: [], skip: [],
    };
    return { headers: table.headers, csv: null, questions: table.questions, suggested: map ?? empty };
  }
  if (map === null) {
    const guessed = suggest(table);
    const recipientBad = guessed.map.recipient !== null ? badRecipients(table, guessed.map.recipient) : [];
    const questions = guessed.questions.concat(
      recipientBad.length > 0 ? [nameQuestion(table.headers[guessed.map.recipient!] ?? "", recipientBad[0] ?? "")] : [],
    );
    const csv = questions.length === 0 ? canonicalCsv(table, guessed.map) : null;
    return { headers: table.headers, csv, questions, suggested: guessed.map };
  }
  const questions = validateMap(table, map);
  const recipientBad = map.recipient !== null && map.recipient >= 0 && map.recipient < table.headers.length
    ? badRecipients(table, map.recipient) : [];
  if (recipientBad.length > 0 && map.recipient !== null) {
    questions.push(nameQuestion(table.headers[map.recipient] ?? "", recipientBad[0] ?? ""));
  }
  const csv = questions.length === 0 ? canonicalCsv(table, map) : null;
  return { headers: table.headers, csv, questions, suggested: map };
}
