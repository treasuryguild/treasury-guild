import { describe, expect, it } from "vitest";
import { assetNameByteLength, joinUnit, splitUnit } from "./units";

const POLICY = "a".repeat(56);

describe("units", () => {
  it("splits a unit into policy id and asset name hex", () => {
    expect(splitUnit(`${POLICY}48656c6c6f`)).toEqual({
      policyId: POLICY,
      assetNameHex: "48656c6c6f",
    });
    expect(splitUnit(POLICY)).toEqual({ policyId: POLICY, assetNameHex: "" });
  });

  it("joins policy id and asset name, treating null as empty", () => {
    expect(joinUnit(POLICY, "ff")).toBe(`${POLICY}ff`);
    expect(joinUnit(POLICY, null)).toBe(POLICY);
    expect(joinUnit(POLICY, undefined)).toBe(POLICY);
  });

  it("counts asset name bytes", () => {
    expect(assetNameByteLength(POLICY)).toBe(0);
    expect(assetNameByteLength(`${POLICY}48656c6c6f`)).toBe(5);
  });
});
