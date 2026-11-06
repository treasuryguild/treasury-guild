// One sentence per receipts-import issue, for the preview.
import { LEGACY_MAX_NOTE_CHARS, LEGACY_MAX_ROWS, LEGACY_MAX_TICKERS, LegacyIssueCode as Code } from "@/lib/constants";
import { legacyIssueText } from "./issueText";
import type { LegacyIssue } from "./types";

export function receiptIssueText(issue: LegacyIssue): string {
  const column = issue.column ?? "";
  const value = issue.value ?? "";
  switch (issue.code) {
    case Code.BadTickerColumn:
      return `"${column}" is not a token ticker. Every column other than date, source, commitment and note must be a ticker such as ADA.`;
    case Code.NoTickerColumns:
      return "The header has no token column. Add one column per token, named by its ticker (for example ADA).";
    case Code.UnresolvedSource:
      return `The funding source "${value}" could not be matched. Create it on the Funding page, or choose it below.`;
    case Code.UnresolvedCommitment:
      return `The commitment "${value}" could not be matched under its funding source.`;
    case Code.CommitmentWithoutSource:
      return value
        ? `Commitment "${value}" needs a funding source on the same line.`
        : "A commitment needs a funding source on the same line.";
    case Code.NoteTooLong:
      return `The note is longer than ${LEGACY_MAX_NOTE_CHARS} characters.`;
    case Code.TooManyTickers:
      return `The file has ${value} token columns; at most ${LEGACY_MAX_TICKERS} are allowed.`;
    case Code.TooManyRows:
      return `The file has ${value} rows; at most ${LEGACY_MAX_ROWS} can be imported at once. Split it into several files.`;
    case Code.ChainDateMismatch:
      return value
        ? `The CSV date ${value} does not match the transaction's on-chain day (UTC).`
        : "The CSV date does not match the transaction's on-chain day (UTC).";
    default:
      return legacyIssueText(issue);
  }
}
