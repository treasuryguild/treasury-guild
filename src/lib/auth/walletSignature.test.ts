import { Address, Ed25519PrivateKey, Ed25519PublicKey, serializeAddress, signData } from "@meshsdk/core-cst";
import { ready } from "@cardano-sdk/crypto";
import { describe, expect, it } from "vitest";
import { signedByPaymentKey, verifyWalletSignature } from "./walletSignature";

// Keys are hashed while this file loads; libsodium's WASM must be up first.
await ready();

// A COSE_Key as CIP-30 wallets return it: {1: 1 (OKP), 3: -8 (EdDSA), -1: 6 (Ed25519), -2: x}.
function coseKey(publicKeyHex: string): string {
  return `a4010103272006215820${publicKeyHex}`;
}

const KEY = "3b6a27bcceb6a42d62a3a8d02a6f0d73653215771de243a63ac048a18b59da29";
const KEY_HASH = String(Ed25519PublicKey.fromBytes(Buffer.from(KEY, "hex")).hash().hex());
const OTHER_HASH = "ab".repeat(28);

describe("signedByPaymentKey", () => {
  it("accepts the address's own payment key (base and enterprise)", () => {
    expect(signedByPaymentKey(serializeAddress({ pubKeyHash: KEY_HASH, stakeCredentialHash: OTHER_HASH }, 0), coseKey(KEY))).toBe(true);
    expect(signedByPaymentKey(serializeAddress({ pubKeyHash: KEY_HASH }, 1), coseKey(KEY))).toBe(true);
  });

  it("refuses a key that is only the address's stake key", () => {
    // Mesh's checkSignature lets this through; the login must not.
    const borrowed = serializeAddress({ pubKeyHash: OTHER_HASH, stakeCredentialHash: KEY_HASH }, 0);
    expect(signedByPaymentKey(borrowed, coseKey(KEY))).toBe(false);
  });

  it("refuses a script payment address and unreadable input", () => {
    expect(signedByPaymentKey(serializeAddress({ scriptHash: KEY_HASH, stakeCredentialHash: KEY_HASH }, 0), coseKey(KEY))).toBe(false);
    expect(signedByPaymentKey(serializeAddress({ pubKeyHash: KEY_HASH }, 0), "zz")).toBe(false);
    expect(signedByPaymentKey("not an address", coseKey(KEY))).toBe(false);
  });
});

describe("verifyWalletSignature", () => {
  // A throwaway key: sign as a wallet would, then verify like login and ballots do.
  const privateKey = Ed25519PrivateKey.fromNormalBytes(Buffer.alloc(32, 7));
  const keyHash = String(privateKey.toPublic().hash().hex());
  const own = serializeAddress({ pubKeyHash: keyHash, stakeCredentialHash: OTHER_HASH }, 0);
  const text = "Guild Vault ballot\nchoice: agree";
  const signed = signData(text, { address: Address.fromBech32(own), key: privateKey });

  it("accepts the exact text signed by the address's payment key", async () => {
    expect(await verifyWalletSignature(text, signed, own)).toBe(true);
  });

  it("refuses altered text, another address and garbage", async () => {
    expect(await verifyWalletSignature(text.replace("agree", "block"), signed, own)).toBe(false);
    const stakeOnly = serializeAddress({ pubKeyHash: OTHER_HASH, stakeCredentialHash: keyHash }, 0);
    const stakeSigned = signData(text, { address: Address.fromBech32(stakeOnly), key: privateKey });
    expect(await verifyWalletSignature(text, stakeSigned, stakeOnly)).toBe(false);
    expect(await verifyWalletSignature(text, { key: "zz", signature: "zz" }, own)).toBe(false);
  });
});
