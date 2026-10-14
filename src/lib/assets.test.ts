import { describe, expect, it } from "vitest";
import {
  AssetResolutionError,
  adaLovelaceFromAmounts,
  addQuantity,
  formatQuantity,
  resolveAsset,
  resolveTaskAmounts,
  scaleDecimal,
  tokenFallbackLabel,
} from "./assets";

describe("scaleDecimal", () => {
  it("scales whole and fractional amounts exactly", () => {
    expect(scaleDecimal("7", 6)).toBe(7_000_000n);
    expect(scaleDecimal("10.5", 8)).toBe(1_050_000_000n);
    expect(scaleDecimal("0.000001", 6)).toBe(1n);
    expect(scaleDecimal("30", 0)).toBe(30n);
  });

  it("rejects more fractional digits than the asset supports", () => {
    expect(() => scaleDecimal("1.2345678", 6)).toThrow(/decimal places/);
    expect(() => scaleDecimal("1.5", 0)).toThrow(/decimal places/);
  });

  it("rejects malformed and negative input", () => {
    expect(() => scaleDecimal("-1", 6)).toThrow(/Invalid/);
    expect(() => scaleDecimal("abc", 6)).toThrow(/Invalid/);
    expect(() => scaleDecimal("1e6", 6)).toThrow(/Invalid/);
    expect(() => scaleDecimal("", 6)).toThrow(/Invalid/);
  });
});

describe("formatQuantity", () => {
  it("is the inverse of scaleDecimal", () => {
    expect(formatQuantity(7_000_000n, 6)).toBe("7");
    expect(formatQuantity(1_050_000_000n, 8)).toBe("10.5");
    expect(formatQuantity(1n, 6)).toBe("0.000001");
    expect(formatQuantity(30n, 0)).toBe("30");
  });
});

describe("adaLovelaceFromAmounts", () => {
  it("finds the ADA key case-insensitively and scales to lovelace", () => {
    expect(adaLovelaceFromAmounts({ ADA: "7" })).toBe("7000000");
    expect(adaLovelaceFromAmounts({ ada: "0.5", AGIX: "10" })).toBe("500000");
  });

  it("returns null (never 0) when ADA is absent, zero, or unscalable", () => {
    expect(adaLovelaceFromAmounts(null)).toBeNull();
    expect(adaLovelaceFromAmounts({})).toBeNull();
    expect(adaLovelaceFromAmounts({ AGIX: "10" })).toBeNull();
    expect(adaLovelaceFromAmounts({ ADA: "0" })).toBeNull();
    expect(adaLovelaceFromAmounts({ ADA: "0.0000001" })).toBeNull();
    expect(adaLovelaceFromAmounts({ ADA: "abc" })).toBeNull();
  });
});

describe("resolveAsset", () => {
  const registry = [{ fieldName: "AGIX", unit: "97f5".padEnd(60, "0"), decimals: 8 }];

  it("resolves ADA implicitly and registry entries case-insensitively", () => {
    expect(resolveAsset(registry, "ada")?.unit).toBe("lovelace");
    expect(resolveAsset(registry, "agix")?.decimals).toBe(8);
    expect(resolveAsset(registry, "MINS")).toBeNull();
  });
});

describe("resolveTaskAmounts", () => {
  const registry = [
    { fieldName: "AGIX", unit: "a".repeat(60), decimals: 8 },
    { fieldName: "MINS", unit: "b".repeat(60), decimals: 0 },
  ];

  it("scales every mapped field to on-chain quantities", () => {
    const out = resolveTaskAmounts(
      { amounts: { ADA: "7", AGIX: "10", MINS: "30" }, bounty_lovelace: null },
      registry,
    );
    expect(out.get("lovelace")).toBe(7_000_000n);
    expect(out.get("a".repeat(60))).toBe(1_000_000_000n);
    expect(out.get("b".repeat(60))).toBe(30n);
  });

  it("throws listing every unmapped field", () => {
    try {
      resolveTaskAmounts(
        { amounts: { ADA: "7", FOO: "1", BAR: "2" }, bounty_lovelace: null },
        registry,
      );
      expect.unreachable("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(AssetResolutionError);
      expect((err as AssetResolutionError).unmappedFields).toEqual([
        "FOO",
        "BAR",
      ]);
    }
  });

  it("falls back to bounty_lovelace for legacy rows without amounts", () => {
    const out = resolveTaskAmounts(
      { amounts: null, bounty_lovelace: "5000000" },
      registry,
    );
    expect(out.get("lovelace")).toBe(5_000_000n);
    expect(
      resolveTaskAmounts({ amounts: null, bounty_lovelace: null }, registry)
        .size,
    ).toBe(0);
  });
});

describe("addQuantity", () => {
  it("starts a missing key at the quantity and adds to an existing one", () => {
    const totals = new Map<string, bigint>();
    addQuantity(totals, "lovelace", 5n);
    expect(totals.get("lovelace")).toBe(5n);
    addQuantity(totals, "lovelace", 7n);
    addQuantity(totals, "token", 1n);
    expect([...totals]).toEqual([["lovelace", 12n], ["token", 1n]]);
  });

  it("adds exactly beyond 2^53 and takes negative and zero quantities", () => {
    const totals = new Map<string, bigint>([["lovelace", 9_007_199_254_740_993n]]);
    addQuantity(totals, "lovelace", 9_007_199_254_740_993n);
    expect(totals.get("lovelace")).toBe(18_014_398_509_481_986n);
    addQuantity(totals, "lovelace", -18_014_398_509_481_986n);
    expect(totals.get("lovelace")).toBe(0n);
    // A zero quantity still creates the key.
    addQuantity(totals, "token", 0n);
    expect(totals.has("token")).toBe(true);
  });

  it("works with any key type", () => {
    const totals = new Map<number, bigint>();
    addQuantity(totals, 3, 2n);
    addQuantity(totals, 3, 2n);
    expect(totals.get(3)).toBe(4n);
  });
});

describe("tokenFallbackLabel", () => {
  it("labels a token by the last six characters of its unit, upper-cased", () => {
    expect(tokenFallbackLabel(`${"a".repeat(56)}0123453f2a1b`)).toBe("TOKEN-3F2A1B");
    // A unit with no asset name ends in its policy id.
    expect(tokenFallbackLabel("ab".repeat(28))).toBe("TOKEN-ABABAB");
    expect(tokenFallbackLabel("ff")).toBe("TOKEN-FF");
  });

  it("differs for units of one policy that differ in their asset name", () => {
    const policy = "c".repeat(56);
    expect(tokenFallbackLabel(`${policy}aaaaaa01`)).not.toBe(tokenFallbackLabel(`${policy}aaaaaa02`));
  });
});
