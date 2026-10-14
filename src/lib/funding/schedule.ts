// Read a funding schedule from a CSV, e.g. a funder's release plan that lists
// several communities or tokens side by side
// (`month,sc_allocation,ambassador_allocation`). The admin picks the column
// holding the date (or says there is none: the rows are then consecutive
// periods from a start month) and maps each amount column to a token or skips
// it. Pure and client-safe.
import { scaleDecimal } from "@/lib/assets";
import { alignBudgetMonth, shiftMonth, type BudgetCadence } from "@/lib/budgets";
import { parseCsv, parseCsvAmount, parseCsvMonth } from "@/lib/csv";

/** Periods one schedule may hold (50 years of months). */
export const MAX_SCHEDULE_PERIODS = 600;

/** Header names read as the date column without asking. */
const DATE_HEADERS = /^(month|date|period|release|release[ _-]?(date|month)|month[ _-]?start|start)$/i;

export interface ScheduleIssue {
  /** CSV line (header = 1), or null for the whole file. */
  line: number | null;
  message: string;
}

export interface ScheduleTable {
  headers: string[];
  rows: { line: number; cells: string[] }[];
  issues: ScheduleIssue[];
}

/** The CSV as a table: the header row, the non-blank data rows, and what could not be read at all. */
export function readScheduleCsv(text: string): ScheduleTable {
  const { records, unterminatedQuoteLine } = parseCsv(text);
  if (unterminatedQuoteLine !== null) {
    return { headers: [], rows: [], issues: [{ line: unterminatedQuoteLine, message: "A quoted value opened here is never closed." }] };
  }
  const [header, ...data] = records.filter((r) => r.fields.some((f) => f.trim() !== ""));
  if (!header || data.length === 0) {
    return { headers: [], rows: [], issues: [{ line: null, message: "The file needs a header row and at least one row of amounts." }] };
  }
  const headers = header.fields.map((f, i) => f.trim() || `Column ${i + 1}`);
  const issues: ScheduleIssue[] = [];
  if (new Set(headers.map((h) => h.toLowerCase())).size !== headers.length) {
    issues.push({ line: 1, message: "Two columns have the same name." });
  }
  if (data.length > MAX_SCHEDULE_PERIODS) {
    issues.push({ line: null, message: `A schedule holds at most ${MAX_SCHEDULE_PERIODS} periods.` });
  }
  return {
    headers,
    rows: data.slice(0, MAX_SCHEDULE_PERIODS).map((r) => ({ line: r.line, cells: headers.map((_, i) => (r.fields[i] ?? "").trim()) })),
    issues,
  };
}

/**
 * The column that most likely holds the dates: one named like a date
 * (month, date, period, release_date…), else the first column whose every
 * filled cell reads as a month. Null when none does.
 */
export function suggestDateColumn(table: ScheduleTable): number | null {
  const named = table.headers.findIndex((h) => DATE_HEADERS.test(h.trim()));
  if (named >= 0) return named;
  const index = table.headers.findIndex((_, i) => {
    const filled = table.rows.map((r) => r.cells[i] ?? "").filter((c) => c !== "");
    return filled.length > 0 && filled.every((c) => parseCsvMonth(c) !== null);
  });
  return index >= 0 ? index : null;
}

/** Columns other than the date column holding at least one amount: what can be mapped to a token. */
export function amountColumns(table: ScheduleTable, dateColumn: number | null): number[] {
  return table.headers.map((_, i) => i).filter((i) => i !== dateColumn &&
    table.rows.some((r) => parseCsvAmount(r.cells[i] ?? "").kind === "amount"));
}

export interface ScheduleMapping {
  /** Index of the date column; null = the rows are consecutive periods from `startMonth`. */
  dateColumn: number | null;
  /** "YYYY-MM": the first row's period when there is no date column. */
  startMonth: string | null;
  cadence: BudgetCadence;
  /** Amount columns and the token each is paid in; unmapped columns are skipped. */
  columns: { index: number; unit: string; ticker: string; decimals: number }[];
}

export interface ScheduleAmount {
  unit: string;
  /** Display units, as written. */
  amount: string;
  /** Base units. */
  quantity: string;
}

export interface SchedulePeriod {
  /** "YYYY-MM" */
  month: string;
  amounts: ScheduleAmount[];
}

export interface BuiltSchedule {
  periods: SchedulePeriod[];
  issues: ScheduleIssue[];
  /** Base units per token over every period. */
  totals: Record<string, string>;
}

/**
 * The mapped columns as periods: each row's month (from the date column, or
 * counted from the start month), each mapped cell scaled exactly to its
 * token's decimals (never rounded). Rows without an amount are skipped.
 */
export function buildSchedule(table: ScheduleTable, mapping: ScheduleMapping): BuiltSchedule {
  const issues: ScheduleIssue[] = [...table.issues];
  const periods: SchedulePeriod[] = [];
  const totals = new Map<string, bigint>();
  const step = mapping.cadence === "quarterly" ? 3 : 1;

  if (mapping.columns.length === 0) issues.push({ line: null, message: "Choose the token of at least one amount column." });
  const seenUnits = new Map<string, string>();
  for (const column of mapping.columns) {
    const earlier = seenUnits.get(column.unit);
    if (earlier !== undefined) {
      issues.push({ line: null, message: `${earlier} and ${table.headers[column.index]} are both mapped to ${column.ticker}. Map each token once.` });
    }
    seenUnits.set(column.unit, table.headers[column.index] ?? "");
  }
  if (mapping.dateColumn === null) {
    if (!mapping.startMonth || !/^\d{4}-(0[1-9]|1[0-2])$/.test(mapping.startMonth)) {
      issues.push({ line: null, message: "Choose the month of the first row." });
      return { periods, issues, totals: {} };
    }
    if (alignBudgetMonth(mapping.startMonth, mapping.cadence) !== mapping.startMonth) {
      issues.push({ line: null, message: "A quarterly schedule starts in January, April, July or October." });
    }
  }

  const seenMonths = new Map<string, number>();
  table.rows.forEach((row, position) => {
    let month: string | null;
    if (mapping.dateColumn === null) {
      month = shiftMonth(mapping.startMonth!, position * step);
    } else {
      const raw = row.cells[mapping.dateColumn] ?? "";
      if (raw === "") return;
      month = parseCsvMonth(raw);
      if (!month) {
        issues.push({ line: row.line, message: `"${raw}" is not a date. Use YYYY-MM, YYYY-MM-DD or DD.MM.YYYY.` });
        return;
      }
      if (alignBudgetMonth(month, mapping.cadence) !== month) {
        issues.push({ line: row.line, message: `${month} is not the first month of a quarter.` });
        return;
      }
    }
    const amounts: ScheduleAmount[] = [];
    for (const column of mapping.columns) {
      const raw = row.cells[column.index] ?? "";
      const cell = parseCsvAmount(raw);
      const name = table.headers[column.index];
      if (cell.kind === "none") continue;
      if (cell.kind === "error") {
        issues.push({
          line: row.line,
          message: cell.reason === "comma"
            ? `"${raw}" in ${name} has a comma. Use a dot for decimals and no thousands separators.`
            : `"${raw}" in ${name} is not an amount.`,
        });
        continue;
      }
      try {
        const quantity = scaleDecimal(cell.value, column.decimals);
        amounts.push({ unit: column.unit, amount: cell.value, quantity: quantity.toString() });
        totals.set(column.unit, (totals.get(column.unit) ?? 0n) + quantity);
      } catch {
        issues.push({ line: row.line, message: `${cell.value} in ${name} has more decimal places than ${column.ticker} (${column.decimals}).` });
      }
    }
    if (amounts.length === 0) return;
    const earlier = seenMonths.get(month);
    if (earlier !== undefined) {
      issues.push({ line: row.line, message: `${month} is already on line ${earlier}.` });
      return;
    }
    seenMonths.set(month, row.line);
    periods.push({ month, amounts });
  });

  periods.sort((a, b) => a.month.localeCompare(b.month));
  if (periods.length === 0 && issues.length === 0) issues.push({ line: null, message: "The mapped columns have no amounts." });
  return { periods, issues, totals: Object.fromEntries([...totals].map(([unit, q]) => [unit, q.toString()])) };
}
