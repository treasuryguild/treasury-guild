import { describe, expect, it } from "vitest";
import { serializeNativeScript, type NativeScript } from "@meshsdk/core";
import { decodeTreasuryCbor } from "./treasuryImport";

const keys = ["b".repeat(56), "a".repeat(56)];
const scripts = keys.map((keyHash) => ({ type: "sig" as const, keyHash }));
const encode = (script: NativeScript) => serializeNativeScript(script).scriptCbor!;

describe("treasury CBOR import", () => {
  it.each([
    { type: "all", scripts },
    { type: "any", scripts },
    { type: "atLeast", required: 2, scripts },
  ] satisfies NativeScript[])("preserves $type script bytes and unsorted keys", (paymentScript) => {
    const cbor = encode(paymentScript);
    const decoded = decodeTreasuryCbor(` \n${cbor.toUpperCase()}\n`);
    expect(decoded.scriptCbor).toBe(cbor);
    expect(decoded.keyHashes).toEqual(keys);
    expect(decoded.paymentScript).toEqual(paymentScript);
    expect(decoded.required).toBe(paymentScript.type === "any" ? 1 : 2);
  });

  it.each(["", "abc", "zz", "00", "8200", "0".repeat(32_770)])("rejects malformed or oversized input", (input) => {
    expect(() => decodeTreasuryCbor(input)).toThrow();
  });

  it.each([
    { type: "all", scripts: [] },
    { type: "any", scripts: [scripts[0]!, scripts[0]!] },
    { type: "atLeast", required: 0, scripts },
    { type: "atLeast", required: 3, scripts },
    { type: "all", scripts: [{ type: "any", scripts }] },
    { type: "all", scripts: [scripts[0]!, { type: "before", slot: "123" }] },
  ] satisfies NativeScript[])("rejects an unsupported signing rule %#", (script) => {
    expect(() => decodeTreasuryCbor(encode(script))).toThrow();
  });

  it("rejects trailing data rather than silently changing the script hash", () => {
    expect(() => decodeTreasuryCbor(`${encode({ type: "all", scripts })}00`)).toThrow();
  });
});
