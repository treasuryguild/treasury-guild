// Shared CSV reading for admin uploads (payment history, funding schedules):
// a small RFC 4180 reader (quoted fields, "" escapes, commas and line breaks
// inside quotes, CRLF / LF / CR line ends, a UTF-8 byte-order mark and blank
// lines; every field stays the string it was) and the cell parsers both
// features share. Pure and client-safe.

export interface CsvRecord {
  /** Physical line the record starts on, the header being line 1. */
  line: number;
  fields: string[];
}

export interface CsvResult {
  records: CsvRecord[];
  /** A quote opened on this line was never closed; `records` stops before it. */
  unterminatedQuoteLine: number | null;
}

export function parseCsv(text: string): CsvResult {
  const source = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let field = "";
  let line = 1;
  let recordLine = 1;
  let quoted = false;
  let quoteLine = 0;
  // A record is blank when it is one empty unquoted field.
  let touched = false;

  const endField = () => {
    fields.push(field);
    field = "";
  };
  const endRecord = () => {
    endField();
    if (touched || fields.length > 1 || fields[0] !== "") records.push({ line: recordLine, fields });
    fields = [];
    touched = false;
  };

  for (let i = 0; i < source.length; i++) {
    const ch = source[i]!;
    if (quoted) {
      if (ch === '"') {
        if (source[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          quoted = false;
        }
      } else {
        if (ch === "\n" || (ch === "\r" && source[i + 1] !== "\n")) line++;
        field += ch;
      }
      continue;
    }
    if (ch === '"' && field === "") {
      quoted = true;
      touched = true;
      quoteLine = line;
    } else if (ch === ",") {
      endField();
      touched = true;
    } else if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && source[i + 1] === "\n") i++;
      endRecord();
      line++;
      recordLine = line;
    } else {
      field += ch;
    }
  }
  if (quoted) return { records, unterminatedQuoteLine: quoteLine };
  endRecord();
  return { records, unterminatedQuoteLine: null };
}

const pad = (n: number) => String(n).padStart(2, "0");

/**
 * "15.09.2026", "15.09.26" (20YY) or "2026-09-15" → "2026-09-15", checked
 * against the calendar. Slashes are refused: 03/09 reads as March in one
 * locale and September in another.
 */
export function parseCsvDate(raw: string): string | null {
  const value = raw.trim();
  let year: number, month: number, day: number;
  const dotted = /^(\d{1,2})\.(\d{1,2})\.(\d{2}|\d{4})$/.exec(value);
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (dotted) {
    day = Number(dotted[1]);
    month = Number(dotted[2]);
    year = dotted[3]!.length === 2 ? 2000 + Number(dotted[3]) : Number(dotted[3]);
  } else if (iso) {
    year = Number(iso[1]);
    month = Number(iso[2]);
    day = Number(iso[3]);
  } else {
    return null;
  }
  if (year < 1000 || month < 1 || month > 12 || day < 1) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  if (date.getUTCMonth() !== month - 1) return null;
  return `${year}-${pad(month)}-${pad(day)}`;
}

/** A month: "2026-09", or any day of it in a `parseCsvDate` form → "2026-09". */
export function parseCsvMonth(raw: string): string | null {
  const value = raw.trim();
  const m = /^(\d{4})-(\d{2})$/.exec(value);
  if (m) return Number(m[2]) >= 1 && Number(m[2]) <= 12 && Number(m[1]) >= 1000 ? value : null;
  return parseCsvDate(value)?.slice(0, 7) ?? null;
}

export type CsvAmount =
  | { kind: "none" }
  | { kind: "amount"; value: string }
  | { kind: "error"; reason: "comma" | "malformed" };

/**
 * An amount cell in display units: empty or zero = none; else a plain
 * decimal with a dot ("480", "114.5", ".5"), normalized. A comma is refused
 * rather than guessed: it may be a decimal comma or a thousands separator.
 * Signs and exponents are malformed.
 */
export function parseCsvAmount(raw: string): CsvAmount {
  const value = raw.trim();
  if (value === "") return { kind: "none" };
  if (value.includes(",")) return { kind: "error", reason: "comma" };
  const m = /^(\d*)(?:\.(\d*))?$/.exec(value);
  if (!m || (m[1] === "" && !m[2])) return { kind: "error", reason: "malformed" };
  const whole = (m[1] || "0").replace(/^0+(?=\d)/, "");
  const frac = (m[2] ?? "").replace(/0+$/, "");
  if (/^0*$/.test(whole) && frac === "") return { kind: "none" };
  return { kind: "amount", value: frac ? `${whole}.${frac}` : whole };
}
