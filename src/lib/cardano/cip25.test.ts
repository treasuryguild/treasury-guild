import { describe, expect, it } from "vitest";
import {
  bytesToHex,
  cip25Decimals,
  cip25Entry,
  hexToUtf8,
  joinChunks,
  readCip25Fields,
  utf8ToHex,
} from "./cip25";

const POLICY = "b".repeat(56);

describe("hex <-> utf8", () => {
  it("round-trips", () => {
    expect(utf8ToHex("Hello")).toBe("48656c6c6f");
    expect(hexToUtf8("48656c6c6f")).toBe("Hello");
    expect(hexToUtf8(utf8ToHex("héllo ✓"))).toBe("héllo ✓");
  });

  it("rejects malformed input instead of producing NUL bytes", () => {
    expect(hexToUtf8("")).toBeNull();
    expect(hexToUtf8("abc")).toBeNull();
    expect(hexToUtf8("zz")).toBeNull();
    expect(hexToUtf8("ff")).toBeNull(); // invalid UTF-8
  });
});

describe("joinChunks", () => {
  it("accepts a string or an array of strings", () => {
    expect(joinChunks("abc")).toBe("abc");
    expect(joinChunks(["ab", "c"])).toBe("abc");
    expect(joinChunks(["ab", 1])).toBeNull();
    expect(joinChunks(42)).toBeNull();
  });
});

describe("cip25Entry", () => {
  const meta = {
    [POLICY]: {
      Hello: { name: "v1 entry" },
      "576f726c64": { name: "v2 entry" },
    },
  };

  it("finds v1 (utf8 key) entries", () => {
    expect(cip25Entry(meta, POLICY, "48656c6c6f")).toEqual({ name: "v1 entry" });
  });

  it("falls back to v2 (hex key) entries", () => {
    expect(cip25Entry(meta, POLICY, "576f726c64")).toEqual({ name: "v2 entry" });
  });

  it("prefers an explicit utf8 name when given", () => {
    expect(cip25Entry(meta, POLICY, "ffff", "Hello")).toEqual({ name: "v1 entry" });
  });

  it("returns null for missing policy/asset or non-object metadata", () => {
    expect(cip25Entry(meta, "c".repeat(56), "48656c6c6f")).toBeNull();
    expect(cip25Entry(meta, POLICY, "00")).toBeNull();
    expect(cip25Entry("nope", POLICY, "00")).toBeNull();
    expect(cip25Entry(null, POLICY, "00")).toBeNull();
  });
});

describe("readCip25Fields", () => {
  it("joins chunked strings and validates decimals", () => {
    expect(
      readCip25Fields({
        name: ["Gu", "ild"],
        ticker: "GLD",
        decimals: 6,
        image: "ipfs://cid",
        description: ["a", "b"],
      }),
    ).toEqual({
      name: "Guild",
      ticker: "GLD",
      decimals: 6,
      image: "ipfs://cid",
      description: "ab",
    });
  });

  it("returns nulls for a missing entry", () => {
    expect(readCip25Fields(null)).toEqual({
      name: null,
      ticker: null,
      decimals: null,
      image: null,
      description: null,
    });
  });

  it("only accepts integer decimals in 0..12", () => {
    expect(cip25Decimals(0)).toBe(0);
    expect(cip25Decimals(12)).toBe(12);
    expect(cip25Decimals(13)).toBeNull();
    expect(cip25Decimals(1.5)).toBeNull();
    expect(cip25Decimals("6")).toBeNull();
  });
});

describe("bytesToHex", () => {
  it("renders every byte as two lowercase hex digits, zero-padded", () => {
    expect(bytesToHex(new Uint8Array([0, 1, 15, 16, 171, 255]))).toBe("00010f10abff");
    expect(bytesToHex(new Uint8Array([0, 0, 0]))).toBe("000000");
    expect(bytesToHex(new Uint8Array())).toBe("");
  });

  it("covers every byte value and agrees with Buffer", () => {
    const all = Uint8Array.from({ length: 256 }, (_, i) => i);
    const hex = bytesToHex(all);
    expect(hex).toHaveLength(512);
    expect(hex).toBe(Buffer.from(all).toString("hex"));
    expect(hex).toMatch(/^[0-9a-f]+$/);
    expect(Uint8Array.from(Buffer.from(hex, "hex"))).toEqual(all);
  });

  it("reads only the bytes of a view, and a Buffer like any byte array", () => {
    const backing = new Uint8Array([1, 2, 3, 4, 5]);
    expect(bytesToHex(backing.subarray(1, 3))).toBe("0203");
    expect(bytesToHex(Buffer.from("Hello", "utf8"))).toBe("48656c6c6f");
    expect(bytesToHex(new TextEncoder().encode("é✓"))).toBe(utf8ToHex("é✓"));
  });
});
