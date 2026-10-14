import { describe, expect, it } from "vitest";
import { hmacSha256Hex, safeEqual, sha256Hex } from "./crypto";

describe("sha256Hex", () => {
  it("matches the FIPS 180 vectors", () => {
    expect(sha256Hex("")).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855");
    expect(sha256Hex("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });

  it("hashes the UTF-8 bytes, lower-case hex", () => {
    expect(sha256Hex("é")).toBe(sha256Hex(Buffer.from([0xc3, 0xa9]).toString("utf8")));
    expect(sha256Hex("abc")).toMatch(/^[0-9a-f]{64}$/);
    expect(sha256Hex("abc")).not.toBe(sha256Hex("abd"));
  });
});

describe("hmacSha256Hex", () => {
  it("matches RFC 4231 test case 2", () => {
    expect(hmacSha256Hex("Jefe", "what do ya want for nothing?")).toBe(
      "5bdcc146bf60754e6a042426089575c75a003f089d2739839dec58b964ec3843",
    );
  });

  it("depends on both the key and the message", () => {
    const mac = hmacSha256Hex("secret", "message");
    expect(mac).toMatch(/^[0-9a-f]{64}$/);
    expect(hmacSha256Hex("secret", "message")).toBe(mac);
    expect(hmacSha256Hex("secret2", "message")).not.toBe(mac);
    expect(hmacSha256Hex("secret", "message2")).not.toBe(mac);
    // Not a bare hash of the message, nor of key + message.
    expect(mac).not.toBe(sha256Hex("message"));
    expect(mac).not.toBe(sha256Hex("secretmessage"));
  });
});

describe("safeEqual", () => {
  it("is true for equal strings", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("", "")).toBe(true);
    expect(safeEqual("héllo", "héllo")).toBe(true);
  });

  it("is false for different strings of the same length", () => {
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "ABC")).toBe(false);
  });

  it("is false, not a throw, on a length mismatch", () => {
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("abc", "")).toBe(false);
    expect(safeEqual("", "a")).toBe(false);
  });

  it("compares bytes: same character count, different byte length", () => {
    // "é" is two bytes, "e" one.
    expect(safeEqual("é", "e")).toBe(false);
    expect(safeEqual("é", "ab")).toBe(false);
  });
});
