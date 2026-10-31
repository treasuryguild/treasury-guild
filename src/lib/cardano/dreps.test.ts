import { describe, expect, it } from "vitest";
import {
  DREP_DEFAULT_LIMIT,
  DREP_MAX_LIMIT,
  buildDrepListPath,
  buildDrepLookupPath,
  clampDrepSearchLimit,
  enrichDrepSummaries,
  extractDrepGivenName,
  filterDrepsByGivenName,
  isDrepIdShapedQuery,
  isSpecialDrepId,
  mapKoiosDrepListRow,
  mapKoiosDrepListRows,
  sanitizeDrepSearchQuery,
  sortDrepsByVotingPower,
} from "./dreps";

describe("sanitizeDrepSearchQuery", () => {
  it("trims and strips PostgREST filter metacharacters", () => {
    expect(sanitizeDrepSearchQuery("  Team  ")).toBe("Team");
    expect(sanitizeDrepSearchQuery("Te*am")).toBe("Team");
    expect(sanitizeDrepSearchQuery("a,b(c)d")).toBe("abcd");
  });
});

describe("clampDrepSearchLimit", () => {
  it("defaults and caps", () => {
    expect(clampDrepSearchLimit(undefined)).toBe(DREP_DEFAULT_LIMIT);
    expect(clampDrepSearchLimit(0)).toBe(1);
    expect(clampDrepSearchLimit(999)).toBe(DREP_MAX_LIMIT);
    expect(clampDrepSearchLimit(12.7)).toBe(12);
  });
});

describe("isDrepIdShapedQuery / isSpecialDrepId", () => {
  it("detects bech32 and hex fragments", () => {
    expect(isDrepIdShapedQuery("drep1abc")).toBe(true);
    expect(isDrepIdShapedQuery("DREP1xyz")).toBe(true);
    expect(isDrepIdShapedQuery("c76aaa")).toBe(true);
    expect(isDrepIdShapedQuery("Team")).toBe(false);
    expect(isDrepIdShapedQuery("ab")).toBe(false);
  });

  it("recognises built-in targets", () => {
    expect(isSpecialDrepId("always_abstain")).toBe(true);
    expect(isSpecialDrepId("always_no_confidence")).toBe(true);
    expect(isSpecialDrepId("drep1abc")).toBe(false);
  });
});

describe("buildDrepListPath", () => {
  it("browses registered DReps when q is empty", () => {
    expect(buildDrepListPath({})).toBe(
      "/drep_list?registered=eq.true&select=drep_id%2Chex%2Chas_script%2Cregistered&limit=40&order=drep_id.asc",
    );
  });

  it("searches bech32 and hex with ilike wildcards", () => {
    const path = buildDrepListPath({ q: "drep1abc", limit: 10 });
    expect(path).toContain("limit=10");
    expect(path).toContain("or=(drep_id.ilike.*drep1abc*,hex.ilike.*drep1abc*)");
    expect(path).not.toContain("order=drep_id.asc");
  });

  it("keeps browse order for free-text names (caller over-fetches and filters)", () => {
    const path = buildDrepListPath({ q: "Team", listLimit: 100 });
    expect(path).toContain("limit=100");
    expect(path).toContain("order=drep_id.asc");
    expect(path).not.toContain("or=");
  });
});

describe("buildDrepLookupPath", () => {
  it("looks up by bech32 or hex id", () => {
    expect(buildDrepLookupPath("drep1abc")).toBe(
      "/drep_list?select=drep_id%2Chex%2Chas_script%2Cregistered&limit=1&drep_id=eq.drep1abc",
    );
    const hex = "a".repeat(56);
    const hexPath = buildDrepLookupPath(hex);
    expect(hexPath).toContain(`hex=eq.${hex}`);
    expect(hexPath).not.toContain("drep_id=eq.");
  });
});

describe("extractDrepGivenName", () => {
  it("reads CIP-119 body.givenName from object or JSON string", () => {
    expect(extractDrepGivenName({ body: { givenName: "Team Drep" } })).toBe("Team Drep");
    expect(extractDrepGivenName(JSON.stringify({ body: { givenName: "  X  " } }))).toBe("X");
    expect(extractDrepGivenName({ body: { givenName: "  " } })).toBeNull();
    expect(extractDrepGivenName(null)).toBeNull();
    expect(extractDrepGivenName("{")).toBeNull();
  });
});

describe("map / enrich / filter / sort", () => {
  it("maps list rows and drops incomplete ones", () => {
    expect(
      mapKoiosDrepListRows([
        { drep_id: "drep1abc", hex: "aa", has_script: true, registered: true },
        { drep_id: "  " },
        null,
      ]),
    ).toEqual([
      {
        dRepId: "drep1abc",
        givenName: null,
        votingPower: null,
        registered: true,
        hasScript: true,
      },
    ]);
    expect(mapKoiosDrepListRow({ drep_id: "drep1x" })).toEqual({
      dRepId: "drep1x",
      givenName: null,
      votingPower: null,
      registered: false,
      hasScript: false,
    });
  });

  it("enriches, filters by name, and sorts by voting power", () => {
    const base = mapKoiosDrepListRows([
      { drep_id: "drep1a", registered: true },
      { drep_id: "drep1b", registered: true },
      { drep_id: "drep1c", registered: true },
    ]);
    const enriched = enrichDrepSummaries(
      base,
      new Map([
        ["drep1a", "100"],
        ["drep1b", "300"],
        ["drep1c", null],
      ]),
      new Map([
        ["drep1a", "Alpha"],
        ["drep1b", "Beta Team"],
        ["drep1c", "Gamma"],
      ]),
    );
    expect(sortDrepsByVotingPower(enriched).map((d) => d.dRepId)).toEqual([
      "drep1b",
      "drep1a",
      "drep1c",
    ]);
    expect(filterDrepsByGivenName(enriched, "team", 10).map((d) => d.dRepId)).toEqual([
      "drep1b",
    ]);
  });
});
