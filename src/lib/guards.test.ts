import { describe, expect, it } from "vitest";
import { isRecord, isStringArray, isTxHash, isUuid } from "./guards";

describe("isRecord", () => {
  it("accepts plain objects", () => {
    expect(isRecord({})).toBe(true);
    expect(isRecord({ a: 1 })).toBe(true);
    expect(isRecord(Object.create(null))).toBe(true);
  });

  it("refuses null, arrays and primitives", () => {
    expect(isRecord(null)).toBe(false);
    expect(isRecord(undefined)).toBe(false);
    expect(isRecord([])).toBe(false);
    expect(isRecord([{ a: 1 }])).toBe(false);
    expect(isRecord("text")).toBe(false);
    expect(isRecord(0)).toBe(false);
    expect(isRecord(true)).toBe(false);
    expect(isRecord(() => ({}))).toBe(false);
  });
});

describe("isUuid", () => {
  it("accepts a canonical uuid in either case", () => {
    expect(isUuid("3f2b8c1e-9d4a-4f6b-8a7c-0123456789ab")).toBe(true);
    expect(isUuid("3F2B8C1E-9D4A-4F6B-8A7C-0123456789AB")).toBe(true);
    expect(isUuid("00000000-0000-0000-0000-000000000000")).toBe(true);
  });

  it("refuses anything Postgres could not cast", () => {
    expect(isUuid("")).toBe(false);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid("3f2b8c1e9d4a4f6b8a7c0123456789ab")).toBe(false); // no dashes
    expect(isUuid("3f2b8c1e-9d4a-4f6b-8a7c-0123456789a")).toBe(false); // one short
    expect(isUuid("3f2b8c1e-9d4a-4f6b-8a7c-0123456789abc")).toBe(false); // one long
    expect(isUuid("3f2b8c1e-9d4a-4f6b-8a7c-0123456789ag")).toBe(false); // not hex
    expect(isUuid("{3f2b8c1e-9d4a-4f6b-8a7c-0123456789ab}")).toBe(false);
  });

  it("is anchored: no surrounding text, no trailing newline", () => {
    expect(isUuid(" 3f2b8c1e-9d4a-4f6b-8a7c-0123456789ab")).toBe(false);
    expect(isUuid("3f2b8c1e-9d4a-4f6b-8a7c-0123456789ab\n")).toBe(false);
    expect(isUuid("3f2b8c1e-9d4a-4f6b-8a7c-0123456789ab; drop table tasks")).toBe(false);
  });
});

describe("isTxHash", () => {
  it("accepts a 64-char hex hash", () => {
    expect(isTxHash("ab".repeat(32))).toBe(true);
    expect(isTxHash("AB".repeat(32))).toBe(true);
  });

  it("refuses wrong lengths and non-hex", () => {
    expect(isTxHash("")).toBe(false);
    expect(isTxHash("ab".repeat(31))).toBe(false);
    expect(isTxHash("ab".repeat(33))).toBe(false);
    expect(isTxHash("g".repeat(64))).toBe(false);
  });
});

describe("isStringArray", () => {
  it("accepts arrays of strings, the empty one included", () => {
    expect(isStringArray([])).toBe(true);
    expect(isStringArray(["a", ""])).toBe(true);
  });

  it("refuses mixed arrays and non-arrays", () => {
    expect(isStringArray(["a", 1])).toBe(false);
    expect(isStringArray(["a", null])).toBe(false);
    expect(isStringArray([["a"]])).toBe(false);
    expect(isStringArray("a")).toBe(false);
    expect(isStringArray({ 0: "a", length: 1 })).toBe(false);
    expect(isStringArray(null)).toBe(false);
    expect(isStringArray(undefined)).toBe(false);
  });
});
