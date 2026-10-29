import { describe, expect, it } from "vitest";
import { isValidHandle } from "./handles";

describe("isValidHandle", () => {
  it("accepts short letter/digit handles with _ and -", () => {
    expect(isValidHandle("ab")).toBe(true);
    expect(isValidHandle("ada-lovelace")).toBe(true);
    expect(isValidHandle("Ada_42")).toBe(true);
    expect(isValidHandle("a".repeat(32))).toBe(true);
  });

  it("refuses empty, too long, spaces and punctuation", () => {
    expect(isValidHandle("")).toBe(false);
    expect(isValidHandle("a")).toBe(false);
    expect(isValidHandle("a".repeat(33))).toBe(false);
    expect(isValidHandle("ada lovelace")).toBe(false);
    expect(isValidHandle("ada@io")).toBe(false);
    expect(isValidHandle("ada.lovelace")).toBe(false);
  });
});
