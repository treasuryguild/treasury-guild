import { describe, expect, it } from "vitest";
import {
  API_SCOPE_DESCRIPTIONS,
  API_SCOPES,
  formatApiScopes,
  isApiScope,
  isWriteScope,
  knownScopes,
  parseApiScopes,
  READ_SCOPES,
} from "./scopes";

describe("API_SCOPES", () => {
  it("describes every scope for the consent page", () => {
    expect(Object.keys(API_SCOPE_DESCRIPTIONS).sort()).toEqual([...API_SCOPES].sort());
    for (const scope of API_SCOPES) expect(API_SCOPE_DESCRIPTIONS[scope].length).toBeGreaterThan(0);
  });
});

describe("write scopes", () => {
  it("tells writes from reads, and READ_SCOPES holds only reads", () => {
    expect(isWriteScope("proposals:write")).toBe(true);
    expect(isWriteScope("communities:read")).toBe(false);
    expect(READ_SCOPES).toEqual(["communities:read"]);
  });
});

describe("isApiScope", () => {
  it("accepts catalogue scopes only, exactly", () => {
    expect(isApiScope("communities:read")).toBe(true);
    expect(isApiScope("communities:write")).toBe(false);
    expect(isApiScope("Communities:Read")).toBe(false);
    expect(isApiScope(" communities:read")).toBe(false);
    expect(isApiScope("")).toBe(false);
    expect(isApiScope("toString")).toBe(false);
  });
});

describe("parseApiScopes", () => {
  it("reads a space-delimited scope string", () => {
    expect(parseApiScopes("communities:read")).toEqual(["communities:read"]);
  });

  it("drops unknown scopes and duplicates", () => {
    expect(parseApiScopes("openid communities:read admin communities:read")).toEqual(["communities:read"]);
    expect(parseApiScopes("communities:write openid")).toEqual([]);
  });

  it("splits on any whitespace", () => {
    expect(parseApiScopes("  communities:read\topenid\n")).toEqual(["communities:read"]);
  });

  it("does not split on commas", () => {
    expect(parseApiScopes("communities:read,openid")).toEqual([]);
  });

  it("is empty for a missing or empty scope", () => {
    expect(parseApiScopes(null)).toEqual([]);
    expect(parseApiScopes(undefined)).toEqual([]);
    expect(parseApiScopes("")).toEqual([]);
    expect(parseApiScopes("   ")).toEqual([]);
  });
});

describe("knownScopes", () => {
  it("keeps the known entries of a stored list", () => {
    expect(knownScopes(["legacy:scope", "communities:read", "communities:read"])).toEqual(["communities:read"]);
    expect(knownScopes([])).toEqual([]);
    expect(knownScopes(["nope"])).toEqual([]);
  });

  it("reads each entry as a scope list of its own (an entry with a space splits)", () => {
    expect(knownScopes(["openid communities:read"])).toEqual(["communities:read"]);
  });
});

describe("formatApiScopes", () => {
  it("joins with single spaces", () => {
    expect(formatApiScopes(["communities:read"])).toBe("communities:read");
    expect(formatApiScopes([])).toBe("");
  });

  it("round-trips through parseApiScopes", () => {
    expect(parseApiScopes(formatApiScopes([...API_SCOPES]))).toEqual([...API_SCOPES]);
    expect(formatApiScopes(parseApiScopes("x communities:read y"))).toBe("communities:read");
  });
});
