import { describe, expect, it } from "vitest";
import {
  STAKE_POOL_DEFAULT_LIMIT,
  STAKE_POOL_MAX_LIMIT,
  buildPoolListPath,
  buildPoolLookupPath,
  clampPoolSearchLimit,
  mapKoiosPoolRow,
  mapKoiosPoolRows,
  sanitizePoolSearchQuery,
} from "./stakePools";

describe("sanitizePoolSearchQuery", () => {
  it("trims and strips PostgREST filter metacharacters", () => {
    expect(sanitizePoolSearchQuery("  NUTS  ")).toBe("NUTS");
    expect(sanitizePoolSearchQuery("NU*TS")).toBe("NUTS");
    expect(sanitizePoolSearchQuery("a,b(c)d")).toBe("abcd");
    expect(sanitizePoolSearchQuery("(*)")).toBe("");
  });
});

describe("clampPoolSearchLimit", () => {
  it("defaults and caps", () => {
    expect(clampPoolSearchLimit(undefined)).toBe(STAKE_POOL_DEFAULT_LIMIT);
    expect(clampPoolSearchLimit(0)).toBe(1);
    expect(clampPoolSearchLimit(999)).toBe(STAKE_POOL_MAX_LIMIT);
    expect(clampPoolSearchLimit(12.7)).toBe(12);
  });
});

describe("buildPoolListPath", () => {
  it("browses registered pools with tickers when q is empty", () => {
    expect(buildPoolListPath({})).toBe(
      "/pool_list?pool_status=eq.registered&select=pool_id_bech32%2Cticker%2Cmargin%2Cfixed_cost%2Cactive_stake%2Cpool_status&limit=40&ticker=not.is.null&order=ticker.asc",
    );
  });

  it("searches ticker and pool ids with ilike wildcards", () => {
    const path = buildPoolListPath({ q: "NUTS", limit: 10 });
    expect(path).toContain("limit=10");
    expect(path).toContain(
      "or=(ticker.ilike.*NUTS*,pool_id_bech32.ilike.*NUTS*,pool_id_hex.ilike.*NUTS*)",
    );
    expect(path).not.toContain("ticker=not.is.null");
  });

  it("ignores a query that sanitizes to empty", () => {
    expect(buildPoolListPath({ q: "***" })).toContain("ticker=not.is.null");
  });
});

describe("buildPoolLookupPath", () => {
  it("looks up by bech32 or hex id", () => {
    expect(buildPoolLookupPath("pool1abc")).toBe(
      "/pool_list?select=pool_id_bech32%2Cticker%2Cmargin%2Cfixed_cost%2Cactive_stake%2Cpool_status&limit=1&pool_id_bech32=eq.pool1abc",
    );
    const hex = "a".repeat(56);
    const hexPath = buildPoolLookupPath(hex);
    expect(hexPath).toContain(`pool_id_hex=eq.${hex}`);
    expect(hexPath).not.toContain("pool_id_bech32=eq.");
  });
});

describe("mapKoiosPoolRows", () => {
  it("maps and drops incomplete rows", () => {
    expect(
      mapKoiosPoolRows([
        {
          pool_id_bech32: "pool1abc",
          ticker: "ABC",
          margin: 0.02,
          fixed_cost: "340000000",
          active_stake: "1000",
          pool_status: "registered",
        },
        { pool_id_bech32: "  " },
        null,
        { ticker: "NOID" },
      ]),
    ).toEqual([
      {
        poolId: "pool1abc",
        ticker: "ABC",
        margin: 0.02,
        fixedCost: "340000000",
        activeStake: "1000",
        status: "registered",
      },
    ]);
    expect(mapKoiosPoolRow({ pool_id_bech32: "pool1x" })).toEqual({
      poolId: "pool1x",
      ticker: null,
      margin: null,
      fixedCost: null,
      activeStake: null,
      status: "registered",
    });
  });
});
