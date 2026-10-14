import { describe, expect, it, vi } from "vitest";
import {
  formatUnitAmount,
  payoutRowAmounts,
  registryFromRows,
  unitDisplayFromRegistry,
  unitDisplayLoader,
  unitTicker,
} from "./assetRegistry";

const HOSKY = `${"a".repeat(56)}484f534b59`;
const UNKNOWN = `${"c".repeat(56)}00`;

describe("assetRegistry", () => {
  const registry = registryFromRows([
    { field_name: "HOSKY", unit: HOSKY, decimals: 0 },
  ]);

  it("maps rows to AssetDefs", () => {
    expect(registry).toEqual([{ fieldName: "HOSKY", unit: HOSKY, decimals: 0 }]);
    expect(registryFromRows(null)).toEqual([]);
  });

  it("always seeds ADA into the unit display", () => {
    const display = unitDisplayFromRegistry(registry);
    expect(display.get("lovelace")).toEqual({ ticker: "ADA", decimals: 6 });
    expect(display.get(HOSKY)).toEqual({ ticker: "HOSKY", decimals: 0 });
  });

  it("formats amounts exactly with a hex fallback for unknown units", () => {
    const display = unitDisplayFromRegistry(registry);
    expect(formatUnitAmount("lovelace", 1_500_000n, display)).toBe("1.5 ADA");
    expect(formatUnitAmount(HOSKY, "300", display)).toBe("300 HOSKY");
    expect(formatUnitAmount(UNKNOWN, 7n, display)).toBe("7 cccccccccccc…");
    expect(unitTicker(UNKNOWN, display)).toBe("cccccccccccc…");
  });

  it("still renders ADA when the display map is empty", () => {
    expect(formatUnitAmount("lovelace", 2_000_000n, new Map())).toBe("2 ADA");
  });
});

describe("unitDisplayLoader", () => {
  const hosky = [{ fieldName: "HOSKY", unit: HOSKY, decimals: 0 }];

  it("loads each community's registry once and serves the cached display afterwards", async () => {
    const load = vi.fn(async (communityId: string) => (communityId === "c1" ? hosky : []));
    const displayFor = unitDisplayLoader(load);

    const first = await displayFor("c1");
    expect(first.get(HOSKY)).toEqual({ ticker: "HOSKY", decimals: 0 });
    expect(first.get("lovelace")).toEqual({ ticker: "ADA", decimals: 6 });
    expect(await displayFor("c1")).toBe(first);
    expect(await displayFor("c1")).toBe(first);
    expect(load).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledWith("c1");
  });

  it("keeps communities apart", async () => {
    const load = vi.fn(async (communityId: string) => (communityId === "c1" ? hosky : []));
    const displayFor = unitDisplayLoader(load);
    const one = await displayFor("c1");
    const two = await displayFor("c2");
    expect(two).not.toBe(one);
    expect(two.has(HOSKY)).toBe(false);
    // An empty registry is still a display (ADA only), and still cached.
    expect([...two.keys()]).toEqual(["lovelace"]);
    await displayFor("c2");
    await displayFor("c1");
    expect(load.mock.calls.map(([id]) => id)).toEqual(["c1", "c2"]);
  });

  it("caches per loader, not globally", async () => {
    const load = vi.fn(async () => hosky);
    await unitDisplayLoader(load)("c1");
    await unitDisplayLoader(load)("c1");
    expect(load).toHaveBeenCalledTimes(2);
  });

  it("does not cache a failed load", async () => {
    const load = vi.fn(async () => hosky).mockRejectedValueOnce(new Error("unavailable"));
    const displayFor = unitDisplayLoader(load);
    await expect(displayFor("c1")).rejects.toThrow("unavailable");
    expect((await displayFor("c1")).get(HOSKY)).toEqual({ ticker: "HOSKY", decimals: 0 });
    expect(load).toHaveBeenCalledTimes(2);
  });
});

describe("payoutRowAmounts", () => {
  const display = unitDisplayFromRegistry([{ fieldName: "GVTT", unit: HOSKY, decimals: 2 }]);

  it("turns payout rows into ticker, decimals and an exact quantity", () => {
    expect(payoutRowAmounts([
      { unit: "lovelace", amount: "1500000" },
      { unit: HOSKY, amount: "12345678901234567890" },
    ], display)).toEqual([
      { ticker: "ADA", decimals: 6, quantity: 1_500_000n },
      { ticker: "GVTT", decimals: 2, quantity: 12_345_678_901_234_567_890n },
    ]);
    expect(payoutRowAmounts([], display)).toEqual([]);
  });

  it("falls back to 0 decimals and a short hex ticker for a unit the display does not know", () => {
    expect(payoutRowAmounts([{ unit: UNKNOWN, amount: "7" }], display))
      .toEqual([{ ticker: "cccccccccccc…", decimals: 0, quantity: 7n }]);
    // Even ADA, when the display map has no entry for it.
    expect(payoutRowAmounts([{ unit: "lovelace", amount: "7" }], new Map()))
      .toEqual([{ ticker: "lovelace…", decimals: 0, quantity: 7n }]);
  });

  it("keeps one entry per row, in order, without merging a repeated unit", () => {
    const rows = [{ unit: "lovelace", amount: "1" }, { unit: HOSKY, amount: "2" }, { unit: "lovelace", amount: "3" }];
    expect(payoutRowAmounts(rows, display).map((a) => [a.ticker, a.quantity])).toEqual([["ADA", 1n], ["GVTT", 2n], ["ADA", 3n]]);
  });

  it("throws on an amount that is not a whole base-unit quantity", () => {
    expect(() => payoutRowAmounts([{ unit: "lovelace", amount: "1.5" }], display)).toThrow();
  });
});
