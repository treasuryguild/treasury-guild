// One sentence per import issue, for the Treasury page's import queue.

import { ChainImportIssueCode as Code } from "@/lib/constants";
import type { ChainImportIssue } from "./types";

export function chainImportIssueText(issue: ChainImportIssue): string {
  switch (issue.code) {
    case Code.UnsupportedVersion:
      return `The record uses format version ${issue.version}, which this app cannot import.`;
    case Code.BadMetadata:
      return `The on-chain record cannot be read: ${issue.detail}.`;
    case Code.SlugMismatch:
      return `The record belongs to the community "${issue.slug}", not this one.`;
    case Code.WorkgroupMissing:
      return `This community has no workgroup named "${issue.name}".`;
    case Code.WorkgroupAmbiguous:
      return `Several workgroups are named "${issue.name}". Choose the one these tasks belong to.`;
    case Code.WorkgroupArchived:
      return `The workgroup "${issue.name}" is archived. Restore it or choose another workgroup.`;
    case Code.UnknownTicker:
      return `The token "${issue.ticker}" could not be matched to a token in this transaction.`;
    case Code.NumberConflict:
      return `Task #${issue.chainNumber} is already "${issue.existing.title}" here, and ${issue.reason}.`;
    case Code.AmountMismatch:
      return `Output #${issue.outputIndex + 1} does not match the record: ${issue.detail}.`;
    case Code.OutputMissing:
      return `The record names output #${issue.outputIndex + 1}, which the transaction does not have.`;
    case Code.UnknownTreasury:
      return `Output #${issue.outputIndex + 1} is marked as a transfer, but ${issue.address} is not one of this community's treasuries.`;
    case Code.TransferMismatch:
      return `Output #${issue.outputIndex + 1} pays this community's treasury ${issue.address}, but is not marked as a transfer.`;
    case Code.MissingCbor:
      return "The chain provider has no copy of this transaction's bytes.";
    case Code.HashMismatch:
      return "The transaction bytes the chain provider returned do not match the transaction hash.";
    case Code.ImportFailed:
      return `The import failed: ${issue.detail}.`;
  }
}

/** Issues an admin resolves by naming a workgroup, by metadata name. */
export function workgroupNamesToResolve(issues: readonly ChainImportIssue[]): string[] {
  const names = new Set<string>();
  for (const issue of issues) {
    if (
      issue.code === Code.WorkgroupMissing ||
      issue.code === Code.WorkgroupAmbiguous ||
      issue.code === Code.WorkgroupArchived
    ) {
      names.add(issue.name);
    }
  }
  return [...names];
}

/** Chain numbers an admin can import under a new number. */
export function conflictingNumbers(issues: readonly ChainImportIssue[]): number[] {
  return issues.flatMap((issue) => (issue.code === Code.NumberConflict ? [issue.chainNumber] : []));
}
