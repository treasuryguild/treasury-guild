import { describe, expect, it } from "vitest";
import { MultisigWallet, checkValidAddress, paymentKeyHash } from "./multisigSDK";

// Two throwaway preprod addresses (public test vectors, no funds expected)
const ADDR_A =
  "addr_test1qp86rhgehcs4k99rpu48879jncjmeytlhv4nxfd3sw2def6xxu4ylafkwgp2ad5l74sa3s75ttr3enxg2ps2qtrpanyswgshl2";

describe("address validation", () => {
  it("accepts a valid preprod address", () => {
    expect(checkValidAddress(ADDR_A)).toBe(true);
  });

  it("rejects garbage", () => {
    expect(checkValidAddress("not-an-address")).toBe(false);
  });
});

describe("MultisigWallet", () => {
  const hashA = paymentKeyHash(ADDR_A);
  // synthetic co-signer key hashes (28 bytes hex)
  const hashB = "a".repeat(56);
  const hashC = "0".repeat(56);

  function makeWallet(keyHashes: string[]) {
    return new MultisigWallet(
      "Test",
      keyHashes.map((keyHash) => ({ keyHash, role: 0, name: "" })),
      "",
      2,
      0,
    );
  }

  it("derives a deterministic script address regardless of key order", () => {
    const w1 = makeWallet([hashA, hashB, hashC]);
    const w2 = makeWallet([hashC, hashA, hashB]);
    const s1 = w1.getScript();
    const s2 = w2.getScript();
    expect(s1.address).toBe(s2.address);
    expect(s1.scriptCbor).toBe(s2.scriptCbor);
    expect(s1.address.startsWith("addr_test")).toBe(true);
  });

  it("sorts keys lexicographically per CIP-1854", () => {
    const w = makeWallet([hashA, hashB, hashC]);
    const hashes = w.keys.map((k) => k.keyHash);
    expect(hashes).toEqual([...hashes].sort((a, b) => a.localeCompare(b)));
  });

  it("throws without payment keys", () => {
    const w = new MultisigWallet("Empty", [], "", 1, 0);
    expect(() => w.getScript()).toThrow();
  });

  it("network flag switches the address prefix", () => {
    const preprod = makeWallet([hashA, hashB]).getScript().address;
    const mainnet = new MultisigWallet(
      "Test",
      [
        { keyHash: hashA, role: 0, name: "" },
        { keyHash: hashB, role: 0, name: "" },
      ],
      "",
      2,
      1,
    ).getScript().address;
    expect(preprod.startsWith("addr_test1")).toBe(true);
    expect(mainnet.startsWith("addr1")).toBe(true);
  });
});
