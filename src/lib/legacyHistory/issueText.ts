// One sentence per payment-history issue, for the import preview.
import {
  LEGACY_MAX_DISTINCT_TX, LEGACY_MAX_NOTE_CHARS, LEGACY_MAX_ROWS, LEGACY_MAX_TASK_CHARS, LEGACY_MAX_TICKERS,
  LegacyIssueCode as Code,
} from "@/lib/constants";
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
      return `"${value}" is not a date. Use DD.MM.YYYY, DD.MM.YY, YYYY-MM-DD, or a slash date with day above 12 (15/09/2026 or 09/15/2026).`;
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
    case Code.MissingTxHash:
      return "This line has no transaction hash.";
    case Code.BadTxHash:
      return value
        ? `"${value}" is not a transaction hash (64 hexadecimal characters).`
        : "The transaction hash is not valid.";
    case Code.MissingOutputIndex:
      return "This line has no output index.";
    case Code.BadOutputIndex:
      return value
        ? `Output index "${value}" is not a non-negative whole number.`
        : "The output index is not valid.";
    case Code.AmbiguousOutput:
      return "This transaction has more than one matching output; name the outputIndex.";
    case Code.TxNotFound:
      return value
        ? `Transaction ${value} was not found on chain.`
        : "The transaction was not found on chain.";
    case Code.WalletNotInput:
      return "The previous wallet did not spend in this transaction.";
    case Code.OutputNotFound:
      return "This transaction has no output at that index.";
    case Code.RecipientMismatch:
      return "The named output's address does not match this line's userId (full address or its last 6+ characters).";
    case Code.AmountExceedsOutput:
      return "The claimed amounts exceed what that output carries.";
    case Code.TooManyDistinctTx:
      return `The file names too many distinct transactions; at most ${LEGACY_MAX_DISTINCT_TX} are allowed per import.`;
    case Code.FullAddressRequired:
      return "Chain verification could not resolve this line to a full bech32 address.";
    case Code.ChainDateMismatch:
      return value
        ? `The CSV date ${value} does not match the transaction's on-chain day (UTC).`
        : "The CSV date does not match the transaction's on-chain day (UTC).";
    case Code.ScriptCborRequired:
      return "Chain verification needs the treasury script CBOR.";
    case Code.ScriptMismatch:
      return "The treasury script CBOR does not match this community's wallet.";
  }
}
