import { describe, expect, it } from "vitest";
import { resolveTxHash } from "@meshsdk/core-cst";
import { paymentKeyHash } from "@/lib/cardano/multisigSDK";
import { mergeSignerWitnesses, witnessKeyHashes } from "@/lib/cardano/txSignUtils";
import { cosignerAddress, decryptSeed, encryptSeed, generateCosignerKey, witnessSetHex } from "./keys";

// An unsigned transaction (built offline), any body will do for a witness test.
const TX_HEX =
  "84a300d9010281825820000000000000000000000000000000000000000000000000000000000000000000018182581d60" +
  "a".repeat(56) + "1a000f4240021a00029c6ba0f5f6";

describe("co-signer keys", () => {
  it("encrypts a seed with its own IV each time and decrypts it back under the same secret only", () => {
    const seed = new Uint8Array(32).map((_, i) => i);
    const a = encryptSeed(seed, "secret");
    const b = encryptSeed(seed, "secret");
    expect(a).not.toBe(b);
    expect(a.startsWith("v1:")).toBe(true);
    expect(decryptSeed(a, "secret")).toEqual(seed);
    expect(decryptSeed(b, "secret")).toEqual(seed);
    expect(() => decryptSeed(a, "other")).toThrow();
    expect(() => decryptSeed("v2:a:b:c", "secret")).toThrow();
  });

  it("generates a key whose address resolves to its hash on the right network", () => {
    const key = generateCosignerKey(0, "secret");
    expect(key.keyHash).toMatch(/^[0-9a-f]{56}$/);
    expect(key.publicKeyHex).toMatch(/^[0-9a-f]{64}$/);
    expect(key.walletAddress.startsWith("addr_test1")).toBe(true);
    expect(paymentKeyHash(key.walletAddress)).toBe(key.keyHash);
    expect(cosignerAddress(key.keyHash, 1).startsWith("addr1")).toBe(true);
    expect(generateCosignerKey(0, "secret").keyHash).not.toBe(key.keyHash);
  });

  it("signs the core-cst transaction hash so the witness merges like a wallet's", () => {
    const key = generateCosignerKey(0, "secret");
    const seed = decryptSeed(key.encryptedKey, "secret");
    const witness = witnessSetHex(seed, resolveTxHash(TX_HEX));
    const merged = mergeSignerWitnesses(TX_HEX, witness);
    expect(merged.invalidVkeyPubKeysHex).toEqual([]);
    expect(merged.addedKeyHashes).toEqual([key.keyHash]);
    expect(witnessKeyHashes(merged.txHex)).toEqual([key.keyHash]);
    expect(resolveTxHash(merged.txHex)).toBe(resolveTxHash(TX_HEX));
    // A witness over another hash does not verify.
    const wrong = mergeSignerWitnesses(TX_HEX, witnessSetHex(seed, "0".repeat(64)));
    expect(wrong.invalidVkeyPubKeysHex).toHaveLength(1);
  });
});
