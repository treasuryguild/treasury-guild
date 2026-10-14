import { describe, expect, it } from "vitest";
import { ballotText, isFreshBallot, normalizeReason } from "./ballot";

const fields = {
  host: "guildvault.app",
  community: "guild",
  proposalNumber: 12,
  proposalId: "5b8c2c7e-0000-4000-8000-000000000012",
  contentHash: "a".repeat(64),
  rulesHash: "b".repeat(64),
  choice: "block",
  reason: "Not safe to try",
  voter: "addr_test1qexample",
  signedAt: "2026-09-29T12:00:00.000Z",
};

describe("ballotText", () => {
  it("is the exact multi-line text the wallet signs", () => {
    expect(ballotText(fields)).toBe([
      "Treasury Guild ballot",
      "app: guildvault.app",
      "community: guild",
      "proposal: #12 5b8c2c7e-0000-4000-8000-000000000012",
      `content: ${"a".repeat(64)}`,
      `rules: ${"b".repeat(64)}`,
      "choice: block",
      "reason: Not safe to try",
      "voter: addr_test1qexample",
      "signed: 2026-09-29T12:00:00.000Z",
    ].join("\n"));
  });

  it("signs the electorate hash when the proposal has one, and nothing extra when it does not", () => {
    const withElectorate = ballotText({ ...fields, electorateHash: "c".repeat(64) });
    expect(withElectorate.split("\n")[5]).toBe(`rules: ${"b".repeat(64)}`);
    expect(withElectorate.split("\n")[6]).toBe(`electorate: ${"c".repeat(64)}`);
    expect(withElectorate.split("\n")[7]).toBe("choice: block");
    expect(ballotText({ ...fields, electorateHash: null })).toBe(ballotText(fields));
    expect(ballotText(fields)).not.toContain("electorate:");
  });

  it("marks a missing reason and stays under 1 KB with the longest reason", () => {
    expect(ballotText({ ...fields, reason: null })).toContain("\nreason: -\n");
    expect(new TextEncoder().encode(ballotText({ ...fields, reason: "x".repeat(500), voter: "addr1" + "q".repeat(110) })).length)
      .toBeLessThan(1024);
  });
});

describe("normalizeReason", () => {
  it("flattens lines and blanks", () => {
    expect(normalizeReason("  too\n\nrisky\tnow ")).toBe("too risky now");
    expect(normalizeReason("   ")).toBeNull();
    expect(normalizeReason(undefined)).toBeNull();
  });
});

describe("isFreshBallot", () => {
  const now = Date.parse("2026-09-29T12:05:00.000Z");
  it("accepts a ballot signed within ten minutes of issue", () => {
    expect(isFreshBallot("2026-09-29T12:00:00.000Z", now)).toBe(true);
    expect(isFreshBallot("2026-09-29T11:54:59.000Z", now)).toBe(false);
    expect(isFreshBallot("2026-09-29T12:07:00.000Z", now)).toBe(false);
    expect(isFreshBallot("not a date", now)).toBe(false);
  });
});
