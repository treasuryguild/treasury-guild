import { describe, expect, it } from "vitest";
import { matchTokensToFields, type MatchableToken } from "./tokenMatch";
import type { AssetDef } from "./assets";

const AGIX = "a".repeat(56) + "41474958"; // "AGIX"
const AGIX2 = "b".repeat(56) + "41474958";
const MINS = "c".repeat(56) + "4d494e53"; // "MINS"

const agix: MatchableToken = { unit: AGIX, ticker: "AGIX", decimals: 8 };
const agix2: MatchableToken = { unit: AGIX2, ticker: "AGIX", decimals: 6 };
const mins: MatchableToken = { unit: MINS, ticker: "MINS", decimals: 0 };
const noTicker: MatchableToken = { unit: MINS, ticker: null, decimals: 0 };

describe("matchTokensToFields", () => {
  it("auto-matches ticker to field name case-insensitively", () => {
    const { auto, ambiguous, unmatched } = matchTokensToFields(
      ["agix", "MINS"],
      [],
      [agix, mins],
    );
    expect(auto).toEqual([
      { fieldName: "agix", unit: AGIX, decimals: 8 },
      { fieldName: "MINS", unit: MINS, decimals: 0 },
    ]);
    expect(ambiguous.size).toBe(0);
    expect(unmatched).toEqual([]);
  });

  it("treats two tokens sharing a ticker as ambiguous, never auto", () => {
    const { auto, ambiguous, unmatched } = matchTokensToFields(
      ["AGIX"],
      [],
      [agix, agix2],
    );
    expect(auto).toEqual([]);
    expect(unmatched).toEqual([]);
    expect(ambiguous.get("AGIX")).toEqual([agix, agix2]);
  });

  it("never matches ada against wallet tokens", () => {
    const adaImposter: MatchableToken = {
      unit: AGIX,
      ticker: "ADA",
      decimals: 6,
    };
    const { auto, ambiguous, unmatched } = matchTokensToFields(
      ["ADA", "ada"],
      [],
      [adaImposter],
    );
    expect(auto).toEqual([]);
    expect(ambiguous.size).toBe(0);
    expect(unmatched).toEqual([]);
  });

  it("excludes fields already resolvable via the persisted registry", () => {
    const registry: AssetDef[] = [
      { fieldName: "AGIX", unit: AGIX2, decimals: 6 },
    ];
    const { auto, ambiguous, unmatched } = matchTokensToFields(
      ["agix"],
      registry,
      [agix],
    );
    expect(auto).toEqual([]);
    expect(ambiguous.size).toBe(0);
    expect(unmatched).toEqual([]);
  });

  it("never auto-matches tokens without a ticker", () => {
    const { auto, unmatched } = matchTokensToFields(["MINS"], [], [noTicker]);
    expect(auto).toEqual([]);
    expect(unmatched).toEqual(["MINS"]);
  });

  it("reports fields with no candidate token as unmatched", () => {
    const { auto, ambiguous, unmatched } = matchTokensToFields(
      ["COPI"],
      [],
      [agix, mins],
    );
    expect(auto).toEqual([]);
    expect(ambiguous.size).toBe(0);
    expect(unmatched).toEqual(["COPI"]);
  });

  it("dedupes field names case-insensitively", () => {
    const { unmatched } = matchTokensToFields(["COPI", "copi"], [], []);
    expect(unmatched).toEqual(["COPI"]);
  });
});
