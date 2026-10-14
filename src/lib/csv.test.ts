import { describe, expect, it } from "vitest";
import { parseCsv, parseCsvAmount, parseCsvDate, parseCsvMonth } from "./csv";

describe("parseCsv", () => {
  it("reads quoted fields with commas, escaped quotes and line breaks", () => {
    const { records, unterminatedQuoteLine } = parseCsv(
      'a,b,c\r\n1,"x, y","say ""hi"""\r\n2,"two\nlines",z\n',
    );
    expect(unterminatedQuoteLine).toBeNull();
    expect(records).toEqual([
      { line: 1, fields: ["a", "b", "c"] },
      { line: 2, fields: ["1", "x, y", 'say "hi"'] },
      { line: 3, fields: ["2", "two\nlines", "z"] },
    ]);
  });

  it("counts physical lines past a multi-line field and skips blank lines", () => {
    const { records } = parseCsv('h\n"a\r\nb"\n\nc');
    expect(records.map((r) => r.line)).toEqual([1, 2, 5]);
  });

  it("strips a byte-order mark and handles CR-only line ends", () => {
    const { records } = parseCsv("﻿userId,ADA\r1,2");
    expect(records).toEqual([
      { line: 1, fields: ["userId", "ADA"] },
      { line: 2, fields: ["1", "2"] },
    ]);
  });

  it("keeps an empty quoted field and trailing empty fields", () => {
    expect(parseCsv('"",a,\n').records).toEqual([{ line: 1, fields: ["", "a", ""] }]);
  });

  it("reports an unterminated quote by the line it opened on", () => {
    const result = parseCsv('a\nb\n"never closed\nstill');
    expect(result.unterminatedQuoteLine).toBe(3);
    expect(result.records.map((r) => r.fields)).toEqual([["a"], ["b"]]);
  });
});

describe("cell parsers", () => {
  it("reads dates and months", () => {
    expect(parseCsvDate("15.09.26")).toBe("2026-09-15");
    expect(parseCsvDate("2021-07-01")).toBe("2021-07-01");
    expect(parseCsvDate("31.02.2026")).toBeNull();
    expect(parseCsvMonth("2021-07")).toBe("2021-07");
    expect(parseCsvMonth("2021-07-01")).toBe("2021-07");
    expect(parseCsvMonth("01.08.2021")).toBe("2021-08");
    expect(parseCsvMonth("2021-13")).toBeNull();
  });

  it("reads amounts exactly as written", () => {
    expect(parseCsvAmount("211800.72389063")).toEqual({ kind: "amount", value: "211800.72389063" });
    expect(parseCsvAmount("225000")).toEqual({ kind: "amount", value: "225000" });
    expect(parseCsvAmount("0")).toEqual({ kind: "none" });
    expect(parseCsvAmount("1,5")).toEqual({ kind: "error", reason: "comma" });
    expect(parseCsvAmount("-5")).toEqual({ kind: "error", reason: "malformed" });
  });
});
