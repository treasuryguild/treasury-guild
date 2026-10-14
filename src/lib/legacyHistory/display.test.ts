import { describe, expect, it } from "vitest";
import { LegacyIssueCode } from "@/lib/constants";
import { formatAmounts, formatDay, knownWalletFor, legacyContributorKey, legacyTaskKey, legacyWalletLabel, recipientLabel } from "./display";
import { legacyIssueText } from "./issueText";

describe("recipientLabel", () => {
  const known = [
    { wallet: "addr_test1qqqqqqf39ntm", handle: "ana", githubUsername: null },
    { wallet: "addr_test1qqqqqqrcgctj", handle: null, githubUsername: "bo" },
    { wallet: "addr_test1zzzzzzrcgctj", handle: "cy", githubUsername: null },
  ];

  it("names the one wallet ending with the reference", () => {
    expect(recipientLabel("f39ntm", known)).toBe("ana");
  });

  it("shows the ending when no wallet or several match", () => {
    expect(recipientLabel("rcgctj", known)).toBe("…rcgctj");
    expect(recipientLabel("7xcueh", known)).toBe("…7xcueh");
    expect(recipientLabel("addr_test1qqqqqqqq7xcueh", [])).toBe("…7xcueh");
  });

  it("labels a previous wallet", () => {
    expect(legacyWalletLabel("Old multisig")).toBe("Old multisig (previous wallet)");
  });
});

describe("chart keys", () => {
  const known = [
    { wallet: "addr_test1qqqqqqf39ntm", handle: "ana", githubUsername: null },
    { wallet: "addr_test1qqqqqqrcgctj", handle: null, githubUsername: null },
    { wallet: "addr_test1zzzzzzrcgctj", handle: null, githubUsername: null },
  ];

  it("counts a recipient as the member whose wallet is the only match, else by the address end", () => {
    expect(legacyContributorKey("f39ntm", known)).toBe("addr_test1qqqqqqf39ntm");
    expect(legacyContributorKey("rcgctj", known)).toBe("legacy:rcgctj");
    expect(legacyContributorKey("7xcueh", known)).toBe("legacy:7xcueh");
    expect(legacyContributorKey("addr_test1qqqqqqqq7xcueh", [])).toBe("addr_test1qqqqqqqq7xcueh");
  });

  it("groups the lines of one task paid to several people", () => {
    const a = legacyTaskKey({ workgroupId: "w", paidOn: "2026-09-15", task: "Meeting  notes" });
    expect(legacyTaskKey({ workgroupId: "w", paidOn: "2026-09-15", task: "meeting notes " })).toBe(a);
    expect(legacyTaskKey({ workgroupId: "w", paidOn: "2026-09-16", task: "Meeting notes" })).not.toBe(a);
    expect(legacyTaskKey({ workgroupId: "v", paidOn: "2026-09-15", task: "Meeting notes" })).not.toBe(a);
  });
});

describe("formatAmounts", () => {
  it("renders base units exactly with tickers", () => {
    expect(formatAmounts([
      { amount: "48000000001", decimals: 8, ticker: "AGIX" },
      { amount: "114500000", decimals: 6, ticker: "ADA" },
    ])).toBe("480.00000001 AGIX, 114.5 ADA");
  });
});

describe("legacyIssueText", () => {
  it("has a sentence for every code", () => {
    for (const code of Object.values(LegacyIssueCode)) {
      expect(legacyIssueText({ code, line: 2, severity: "error", column: "ADA", value: "x" })).toMatch(/\.$/);
    }
  });
});

describe("knownWalletFor", () => {
  const ana = { wallet: "addr_test1qqqqqqf39ntm", handle: "ana", githubUsername: null };
  const bo = { wallet: "addr_test1qqqqqqrcgctj", handle: null, githubUsername: "bo" };
  const cy = { wallet: "addr_test1zzzzzzrcgctj", handle: "cy", githubUsername: null };
  const known = [ana, bo, cy];

  it("returns the one known wallet ending with the reference", () => {
    expect(knownWalletFor("f39ntm", known)).toBe(ana);
    // A longer ending tells two wallets with the same last six characters apart.
    expect(knownWalletFor("qqqqqqrcgctj", known)).toBe(bo);
    expect(knownWalletFor("zrcgctj", known)).toBe(cy);
    // A whole address is its own ending.
    expect(knownWalletFor(ana.wallet, known)).toBe(ana);
  });

  it("is null when no wallet ends with it, or when several do", () => {
    expect(knownWalletFor("7xcueh", known)).toBeNull();
    expect(knownWalletFor("rcgctj", known)).toBeNull();
    expect(knownWalletFor("f39ntm", [])).toBeNull();
    // The ending must be the end: a match in the middle does not count.
    expect(knownWalletFor("qqqqqq", known)).toBeNull();
  });

  it("matches a wallet stored in another letter case (references are lowercased when read)", () => {
    const upper = { wallet: "ADDR_TEST1QQQQQQF39NTM", handle: "ana", githubUsername: null };
    expect(knownWalletFor("f39ntm", [upper])).toBe(upper);
  });

  it("is what recipientLabel and legacyContributorKey name a recipient by", () => {
    expect(recipientLabel("f39ntm", known)).toBe("ana");
    expect(legacyContributorKey("f39ntm", known)).toBe(knownWalletFor("f39ntm", known)!.wallet);
  });
});

describe("formatDay", () => {
  it("shows the stored day in the viewer's locale", () => {
    expect(formatDay("2026-09-15")).toBe(new Date(2026, 8, 15).toLocaleDateString());
    expect(formatDay("2026-09-15")).not.toBe(formatDay("2026-09-16"));
  });

  it("reads the day as local midnight, so the first and last day of a year keep their year", () => {
    // Parsed as UTC midnight, 1 January would show as 31 December west of Greenwich.
    expect(formatDay("2026-01-01")).toBe(new Date(2026, 0, 1).toLocaleDateString());
    expect(formatDay("2026-01-01")).toContain("2026");
    expect(formatDay("2026-12-31")).toBe(new Date(2026, 11, 31).toLocaleDateString());
    expect(formatDay("2026-12-31")).toContain("2026");
  });
});
