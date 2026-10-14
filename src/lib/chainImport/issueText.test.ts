import { describe, expect, it } from "vitest";
import { ChainImportIssueCode as Code } from "@/lib/constants";
import { chainImportIssueText, conflictingNumbers, workgroupNamesToResolve } from "./issueText";
import type { ChainImportIssue } from "./types";

const ISSUES: ChainImportIssue[] = [
  { code: Code.WorkgroupMissing, name: "Docs" },
  { code: Code.WorkgroupArchived, name: "Old" },
  { code: Code.WorkgroupMissing, name: "Docs" },
  {
    code: Code.NumberConflict,
    chainNumber: 51,
    existing: { id: "t", title: "Write the docs", payState: "paid", paidTxHash: null },
    reason: "it is paid, not waiting for payment",
  },
  { code: Code.AmountMismatch, outputIndex: 0, detail: "carries 1 lovelace, the record says 2" },
];

describe("chainImportIssueText", () => {
  it("has a sentence for every code", () => {
    const sample: Record<string, ChainImportIssue> = {
      [Code.UnsupportedVersion]: { code: Code.UnsupportedVersion, version: "4" },
      [Code.BadMetadata]: { code: Code.BadMetadata, detail: "x" },
      [Code.SlugMismatch]: { code: Code.SlugMismatch, slug: "other" },
      [Code.WorkgroupMissing]: ISSUES[0]!,
      [Code.WorkgroupAmbiguous]: { code: Code.WorkgroupAmbiguous, name: "Twins" },
      [Code.WorkgroupArchived]: ISSUES[1]!,
      [Code.UnknownTicker]: { code: Code.UnknownTicker, ticker: "DOGE" },
      [Code.NumberConflict]: ISSUES[3]!,
      [Code.AmountMismatch]: ISSUES[4]!,
      [Code.OutputMissing]: { code: Code.OutputMissing, outputIndex: 3 },
      [Code.UnknownTreasury]: { code: Code.UnknownTreasury, outputIndex: 1, address: "addr" },
      [Code.TransferMismatch]: { code: Code.TransferMismatch, outputIndex: 1, address: "addr" },
      [Code.MissingCbor]: { code: Code.MissingCbor },
      [Code.HashMismatch]: { code: Code.HashMismatch },
      [Code.ImportFailed]: { code: Code.ImportFailed, detail: "x" },
    };
    for (const code of Object.values(Code)) {
      expect(chainImportIssueText(sample[code]!), code).toMatch(/\.$/);
    }
  });

  it("counts outputs from 1, as the transaction page does", () => {
    expect(chainImportIssueText(ISSUES[4]!)).toContain("Output #1");
    expect(chainImportIssueText(ISSUES[3]!)).toBe(
      'Task #51 is already "Write the docs" here, and it is paid, not waiting for payment.',
    );
  });
});

describe("what an admin can act on", () => {
  it("lists each workgroup name once, and the conflicting numbers", () => {
    expect(workgroupNamesToResolve(ISSUES)).toEqual(["Docs", "Old"]);
    expect(conflictingNumbers(ISSUES)).toEqual([51]);
  });
});
