// The app-held co-signer key (phase 7b): one Ed25519 key per co-signer
// treasury, generated at creation, stored AES-256-GCM encrypted under
// COSIGNER_KEY_SECRET, never rotated (the script is fixed). Its witness is
// an ordinary vkey witness over the core-cst transaction hash; the signature
// itself is core-csl's, which touches no tx bytes (see txSignUtils.ts).
import "server-only";

import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { buildEnterpriseAddress, Hash28ByteBase16 } from "@meshsdk/core-cst";
import { csl } from "@/lib/cardano/csl";
import type { Network } from "@/lib/config";
import { cosignerKeySecret, cronSecret } from "@/lib/env.server";

const VERSION = "v1";

function keySecret(): string {
  return cosignerKeySecret() ?? createHmac("sha256", cronSecret()).update("guild-vault/cosigner-keys").digest("hex");
}

function cipherKey(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

/** "v1:<iv>:<tag>:<ciphertext>", base64 parts. */
export function encryptSeed(seed: Uint8Array, secret = keySecret()): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", cipherKey(secret), iv);
  const ciphertext = Buffer.concat([cipher.update(seed), cipher.final()]);
  return [VERSION, iv.toString("base64"), cipher.getAuthTag().toString("base64"), ciphertext.toString("base64")].join(":");
}

export function decryptSeed(encrypted: string, secret = keySecret()): Uint8Array {
  const [version, iv, tag, ciphertext] = encrypted.split(":");
  if (version !== VERSION || !iv || !tag || !ciphertext) throw new Error("Unknown co-signer key format");
  const decipher = createDecipheriv("aes-256-gcm", cipherKey(secret), Buffer.from(iv, "base64"));
  decipher.setAuthTag(Buffer.from(tag, "base64"));
  return new Uint8Array(Buffer.concat([decipher.update(Buffer.from(ciphertext, "base64")), decipher.final()]));
}

/** The enterprise address of a payment key hash on the network (what `signed_addresses` records). */
export function cosignerAddress(keyHash: string, network: Network): string {
  return buildEnterpriseAddress(network, Hash28ByteBase16(keyHash)).toAddress().toBech32();
}

export interface GeneratedCosignerKey {
  keyHash: string;
  publicKeyHex: string;
  encryptedKey: string;
  walletAddress: string;
}

/** A fresh key, encrypted for storage; the seed leaves this function only in ciphertext. */
export function generateCosignerKey(network: Network, secret?: string): GeneratedCosignerKey {
  const seed = new Uint8Array(randomBytes(32));
  const publicKey = csl.PrivateKey.from_normal_bytes(seed).to_public();
  const keyHash = publicKey.hash().to_hex();
  return {
    keyHash,
    publicKeyHex: Buffer.from(publicKey.as_bytes()).toString("hex"),
    encryptedKey: encryptSeed(seed, secret),
    walletAddress: cosignerAddress(keyHash, network),
  };
}

/** A witness set (hex) holding one vkey witness of the key over the transaction hash. */
export function witnessSetHex(seed: Uint8Array, txHashHex: string): string {
  const privateKey = csl.PrivateKey.from_normal_bytes(seed);
  const signature = privateKey.sign(new Uint8Array(Buffer.from(txHashHex, "hex")));
  const witnesses = csl.Vkeywitnesses.new();
  witnesses.add(csl.Vkeywitness.new(csl.Vkey.new(privateKey.to_public()), signature));
  const set = csl.TransactionWitnessSet.new();
  set.set_vkeys(witnesses);
  return set.to_hex();
}
