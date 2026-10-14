import { describe, expect, it } from "vitest";
import { serializeNativeScript, type NativeScript } from "@meshsdk/core";
import { deserializeNativeScript } from "@meshsdk/core-csl";
import { collectSigKeyHashes, decodeNativeScriptFromCsl } from "./nativeScriptUtils";
import { mintPolicyScript } from "./mintMetadata";

const A = "a".repeat(56);
const B = "b".repeat(56);
const C = "c".repeat(56);

function roundTrip(script: NativeScript) {
  const { scriptCbor } = serializeNativeScript(script, undefined, 0, true);
  return decodeNativeScriptFromCsl(deserializeNativeScript(scriptCbor!));
}

describe("nativeScriptUtils", () => {
  it("decodes all / any / atLeast with their sig leaves", () => {
    const sigs: NativeScript[] = [A, B, C].map((keyHash) => ({ type: "sig", keyHash }));
    expect(roundTrip({ type: "all", scripts: sigs })).toEqual({
      type: "all",
      scripts: [A, B, C].map((keyHash) => ({ type: "sig", keyHash })),
    });
    expect(roundTrip({ type: "any", scripts: sigs }).type).toBe("any");
    const atLeast = roundTrip({ type: "atLeast", required: 2, scripts: sigs });
    expect(atLeast).toMatchObject({ type: "atLeast", required: 2 });
  });

  it("decodes a time-locked forge policy and still finds every signer", () => {
    const treasury: NativeScript = {
      type: "atLeast",
      required: 2,
      scripts: [A, B, C].map((keyHash) => ({ type: "sig", keyHash })),
    };
    const decoded = roundTrip(mintPolicyScript(treasury, 12345));
    expect(decoded.type).toBe("all");
    if (decoded.type !== "all") throw new Error("unreachable");
    expect(decoded.scripts.some((s) => s.type === "timelockExpiry" && s.slot === "12345")).toBe(true);
    expect([...collectSigKeyHashes(decoded)].sort()).toEqual([A, B, C]);
  });

  it("dedupes key hashes that appear in several branches", () => {
    const script: NativeScript = {
      type: "any",
      scripts: [
        { type: "sig", keyHash: A },
        { type: "all", scripts: [{ type: "sig", keyHash: A }, { type: "sig", keyHash: B }] },
      ],
    };
    expect([...collectSigKeyHashes(roundTrip(script))].sort()).toEqual([A, B]);
  });
});
