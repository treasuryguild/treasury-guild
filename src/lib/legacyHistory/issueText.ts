// One sentence per payment-history issue, for the import preview.
import { LEGACY_MAX_ROWS, LEGACY_MAX_TASK_CHARS, LEGACY_MAX_TICKERS, LegacyIssueCode as Code } from "@/lib/constants";
import { MAX_WORKGROUP_REF_BYTES } from "./parse";
import type { LegacyIssue } from "./types";

export function legacyIssueText(issue: LegacyIssue): string {
  const column = issue.column ?? "";
  const value = issue.value ?? "";
  switch (issue.code) {
    case Code.EmptyFile:
      return "The file has no header row and data rows.";
    case Code.UnterminatedQuote:
      return "A quoted value opened here is never closed.";
    case Code.MissingColumn:
      return `The header has no "${column}" column.`;
    case Code.DuplicateColumn:
      return `The header names the column "${column}" twice.`;
    case Code.UnnamedColumn:
      return `Column ${value} has values but no header.`;
    case Code.BadTickerColumn:
      return `"${column}" is not a token ticker. Every column other than userId, task, date and workgroup must be a ticker such as ADA.`;
    case Code.NoTickerColumns:
      return "The header has no token column. Add one column per token, named by its ticker (for example ADA).";
    case Code.TooManyTickers:
      return `The file has ${value} token columns; at most ${LEGACY_MAX_TICKERS} are allowed.`;
    case Code.TooManyRows:
      return `The file has ${value} rows; at most ${LEGACY_MAX_ROWS} can be imported at once. Split it into several files.`;
    case Code.FieldCount:
      return "This line has more values than the header has columns. Put a task containing commas in double quotes.";
    case Code.BadRecipient:
      return value
        ? `"${value}" is not the end of a Cardano address (at least 6 characters, never b, i, o or 1).`
        : "The userId is empty.";
    case Code.EmptyTask:
      return "The task is empty.";
    case Code.TaskTooLong:
      return `The task is longer than ${LEGACY_MAX_TASK_CHARS} characters.`;
    case Code.BadDate:
      return `"${value}" is not a date. Use DD.MM.YYYY, DD.MM.YY or YYYY-MM-DD.`;
    case Code.FutureDate:
      return `${value} is in the future.`;
    case Code.EmptyWorkgroup:
      return "The workgroup is empty.";
    case Code.WorkgroupTooLong:
      return `The workgroup name is longer than ${MAX_WORKGROUP_REF_BYTES} bytes.`;
    case Code.BadAmount:
      return `"${value}" in ${column} is not an amount. Use a plain number such as 480 or 114.5.`;
    case Code.AmountComma:
      return `"${value}" in ${column} has a comma. Use a dot for decimals and no thousands separators.`;
    case Code.TooManyDecimals:
      return `${value} ${column} has more decimal places than the token supports.`;
    case Code.NoAmount:
      return "The line has no amount in any token column.";
    case Code.UnresolvedTicker:
      return `The token "${column}" could not be matched. Choose it below.`;
    case Code.SameToken:
      return `The columns ${column} are the same token. Merge them into one column.`;
    case Code.UnresolvedWorkgroup:
      return `The workgroup "${value}" could not be matched. Choose or create it below.`;
    case Code.ArchivedWorkgroup:
      return `The workgroup "${value}" is archived. Its history is still counted.`;
    case Code.DuplicateInFile:
      return `This line repeats line ${value}. Both are imported.`;
  }
}
