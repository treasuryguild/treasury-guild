import { describe, expect, it } from "vitest";
import type { UTxO } from "@meshsdk/common";
import { minLovelaceForOutput, selectUtxos } from "./utxoSelect";

const AGIX = "a".repeat(56) + "41474958";
const MINS = "b".repeat(56) + "4d494e53";

let counter = 0;
function utxo(amounts: Record<string, string>): UTxO {
  return {
    input: { txHash: "t".repeat(64), outputIndex: counter++ },
    output: {
      address: "addr_test1treasury",
      amount: Object.entries(amounts).map(([unit, quantity]) => ({
        unit,
        quantity,
      })),
    },
  } as UTxO;
}

describe("minLovelaceForOutput", () => {
  it("is at least the known real minimums (conservative)", () => {
    // ADA-only outputs really need ~0.86–0.98 ADA
    expect(
      minLovelaceForOutput({ policies: 0, assets: 0, totalNameBytes: 0 }),
    ).toBeGreaterThanOrEqual(978_370n);
    // one asset, one policy really needs ~1.16 ADA
    expect(
      minLovelaceForOutput({ policies: 1, assets: 1, totalNameBytes: 4 }),
    ).toBeGreaterThanOrEqual(1_160_000n);
    // grows with more assets
    expect(
      minLovelaceForOutput({ policies: 2, assets: 3, totalNameBytes: 12 }),
    ).toBeGreaterThan(
      minLovelaceForOutput({ policies: 1, assets: 1, totalNameBytes: 4 }),
    );
  });
});

describe("selectUtxos", () => {
  it("covers a token requirement across multiple UTxOs, largest first", () => {
    const small = utxo({ lovelace: "2000000", [AGIX]: "30" });
    const big = utxo({ lovelace: "2000000", [AGIX]: "100" });
    const ada = utxo({ lovelace: "20000000" });
    const { selected, shortfall } = selectUtxos(
      [small, big, ada],
      new Map([
        ["lovelace", 3_000_000n],
        [AGIX, 120n],
      ]),
      5_000_000n,
    );
    expect(shortfall).toBeNull();
    expect(selected).toContain(big);
    expect(selected).toContain(small);
    expect(selected).toContain(ada);
  });

  it("prefers pure-ADA UTxOs for the lovelace top-up", () => {
    const tokenHeavy = utxo({ lovelace: "50000000", [MINS]: "999" });
    const agixUtxo = utxo({ lovelace: "2000000", [AGIX]: "100" });
    const pureAda = utxo({ lovelace: "40000000" });
    const { selected, shortfall } = selectUtxos(
      [tokenHeavy, agixUtxo, pureAda],
      new Map([
        ["lovelace", 10_000_000n],
        [AGIX, 50n],
      ]),
      5_000_000n,
    );
    expect(shortfall).toBeNull();
    expect(selected).toContain(agixUtxo);
    expect(selected).toContain(pureAda);
    expect(selected).not.toContain(tokenHeavy); // MINS never dragged in
  });

  it("counts lovelace riding on token UTxOs", () => {
    const rich = utxo({ lovelace: "50000000", [AGIX]: "100" });
    const { selected, shortfall } = selectUtxos(
      [rich],
      new Map([
        ["lovelace", 10_000_000n],
        [AGIX, 50n],
      ]),
      5_000_000n,
    );
    expect(shortfall).toBeNull();
    expect(selected).toEqual([rich]);
  });

  it("reports per-unit shortfalls", () => {
    const some = utxo({ lovelace: "3000000", [AGIX]: "40" });
    const { shortfall } = selectUtxos(
      [some],
      new Map([
        ["lovelace", 10_000_000n],
        [AGIX, 100n],
        [MINS, 30n],
      ]),
      5_000_000n,
    );
    expect(shortfall).not.toBeNull();
    expect(shortfall!.get(AGIX)).toBe(60n);
    expect(shortfall!.get(MINS)).toBe(30n);
    expect(shortfall!.get("lovelace")).toBe(12_000_000n);
  });

  it("selects nothing extra once requirements are met", () => {
    const a = utxo({ lovelace: "100000000" });
    const b = utxo({ lovelace: "100000000" });
    const { selected, shortfall } = selectUtxos(
      [a, b],
      new Map([["lovelace", 10_000_000n]]),
      5_000_000n,
    );
    expect(shortfall).toBeNull();
    expect(selected).toHaveLength(1);
  });
});
