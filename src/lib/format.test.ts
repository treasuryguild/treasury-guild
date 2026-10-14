import { describe, expect, it } from "vitest";
import {
  formatDate,
  formatLovelace,
  formatUnits,
  plural,
  shortAddress,
  shortHash,
  shortUnit,
  truncate,
} from "./format";

describe("formatUnits", () => {
  it("renders exact decimals with thousands grouping", () => {
    expect(formatUnits(1_050_000_000n, 8)).toBe("10.5");
    expect(formatUnits(123_456_789n, 6)).toBe("123.456789");
    expect(formatUnits(1_234_567_000_000n, 6)).toBe("1,234,567");
    expect(formatUnits(0n, 6)).toBe("0");
    expect(formatUnits(5n, 0)).toBe("5");
  });

  it("never loses precision on values beyond 2^53", () => {
    expect(formatUnits("123456789012345678901", 6)).toBe(
      "123,456,789,012,345.678901",
    );
    expect(formatUnits(2n ** 64n, 0)).toBe("18,446,744,073,709,551,616");
  });

  it("accepts strings and numbers and appends a ticker", () => {
    expect(formatUnits("2500000", 6, "ADA")).toBe("2.5 ADA");
    expect(formatUnits(300, 0, "HOSKY")).toBe("300 HOSKY");
  });

  it("handles negatives (burns)", () => {
    expect(formatUnits(-1_500_000n, 6)).toBe("-1.5");
  });
});

describe("formatLovelace", () => {
  it("renders ADA with the symbol", () => {
    expect(formatLovelace(150_000_000)).toBe("150 ₳");
    expect(formatLovelace("1500000")).toBe("1.5 ₳");
  });
});

describe("short forms", () => {
  it("shortens long addresses only", () => {
    expect(shortAddress("addr1short")).toBe("addr1short");
    const long = `addr1${"q".repeat(60)}`;
    expect(shortAddress(long)).toBe(`${long.slice(0, 10)}…${long.slice(-6)}`);
  });

  it("shortens units with or without an ellipsis", () => {
    const unit = `${"a".repeat(56)}ff`;
    expect(shortUnit(unit)).toBe("aaaaaaaaaaaa…");
    expect(shortUnit(unit, false)).toBe("aaaaaaaaaaaa");
  });

  it("shortens hashes past the cutoff", () => {
    expect(shortHash("abc")).toBe("abc");
    expect(shortHash("x".repeat(64))).toBe(`${"x".repeat(20)}…`);
  });
});

describe("plural", () => {
  it("uses the singular for exactly one and the plural otherwise", () => {
    expect(plural(1, "output")).toBe("1 output");
    expect(plural(3, "output")).toBe("3 outputs");
    expect(plural(0, "output")).toBe("0 outputs");
    expect(plural(-1, "output")).toBe("-1 outputs");
    expect(plural(1.5, "output")).toBe("1.5 outputs");
  });

  it("takes an irregular plural", () => {
    expect(plural(1, "entry", "entries")).toBe("1 entry");
    expect(plural(2, "entry", "entries")).toBe("2 entries");
    expect(plural(0, "person", "people")).toBe("0 people");
  });
});

describe("truncate", () => {
  it("leaves text at or under the limit untouched", () => {
    expect(truncate("", 5)).toBe("");
    expect(truncate("hello", 5)).toBe("hello");
    expect(truncate("hi", 5)).toBe("hi");
  });

  it("cuts longer text to exactly the limit, the ellipsis included", () => {
    expect(truncate("hello!", 5)).toBe("hell…");
    expect(truncate("hello world", 5)).toHaveLength(5);
    expect(truncate("hello", 1)).toBe("…");
  });
});

describe("formatDate", () => {
  const iso = "2026-09-15T12:34:56Z";

  it("renders a date by default and a date with its time on request, in the viewer's locale", () => {
    expect(formatDate(iso)).toBe(new Date(iso).toLocaleDateString());
    expect(formatDate(iso, "date")).toBe(formatDate(iso));
    expect(formatDate(iso, "datetime")).toBe(new Date(iso).toLocaleString());
    // The time is only in the datetime style.
    expect(formatDate(iso, "datetime")).not.toBe(formatDate(iso));
    expect(formatDate(iso, "datetime").length).toBeGreaterThan(formatDate(iso).length);
    expect(formatDate(iso)).toContain("2026");
  });

  it("takes a Date as well as an ISO string", () => {
    expect(formatDate(new Date(iso))).toBe(formatDate(iso));
    expect(formatDate(new Date(iso), "datetime")).toBe(formatDate(iso, "datetime"));
  });

  it("tells two days apart", () => {
    expect(formatDate("2026-09-15T12:00:00Z")).not.toBe(formatDate("2026-09-17T12:00:00Z"));
  });
});
