import "server-only";

import type { csl as Csl } from "@meshsdk/core-csl";
import { bytesToHex } from "./cip25";
import { csl } from "./csl";
import {
  resolveTxHash,
  addVKeyWitnessSetToTransaction,
  Transaction as CstTransaction,
  TxCBOR,
  CborSet,
  VkeyWitness,
} from "@meshsdk/core-cst";
import {
  decodeNativeScriptFromCsl,
  collectSigKeyHashes,
} from "./nativeScriptUtils";

// The tx is BUILT with core-cst (MeshTxBuilder's default CardanoSDK serializer),
// so the wallet signs the body hash core-cst produces. core-csl's calculateTxHash
// re-serializes the body to *different* bytes (notably Conway `voting_procedures`
// map order / set tag 258) — a different hash, so valid witnesses would fail to
// verify. Everything here hashes and merges via core-cst so build and verify
// agree, and the original body bytes every signer signed are preserved.
// core-csl is used for read-only witness analysis only.
//
// core-cst VkeyWitness.toCore() returns a [pubKeyHex, signatureHex] tuple.
function cstVkeyPubKeyHex(vkw: { toCore: () => unknown }): string {
  const core = vkw.toCore() as unknown;
  const pub = Array.isArray(core)
    ? (core[0] as string)
    : (core as { vkey: string }).vkey;
  return String(pub).toLowerCase();
}

function toKeyHashHex(publicKey: Csl.PublicKey): string {
  return bytesToHex(publicKey.hash().to_bytes());
}

function toPubKeyHex(publicKey: Csl.PublicKey): string {
  return bytesToHex(publicKey.as_bytes());
}

function extractVkeyWitnesses(
  signedPayloadHex: string,
): Csl.Vkeywitnesses {
  try {
    const signedTx = csl.Transaction.from_hex(signedPayloadHex);
    const txVkeys = signedTx.witness_set().vkeys();
    if (!txVkeys) {
      return csl.Vkeywitnesses.new();
    }
    return csl.Vkeywitnesses.from_bytes(txVkeys.to_bytes());
  } catch {
    const witnessSet = csl.TransactionWitnessSet.from_hex(signedPayloadHex);
    const witnessVkeys = witnessSet.vkeys();
    if (!witnessVkeys) {
      return csl.Vkeywitnesses.new();
    }
    return csl.Vkeywitnesses.from_bytes(witnessVkeys.to_bytes());
  }
}

/**
 * Key hashes of the vkey witnesses in a signed tx: who signed a transaction
 * read back from the chain (read-only, core-csl).
 */
export function witnessKeyHashes(txHex: string): string[] {
  const vkeys = csl.Transaction.from_hex(txHex).witness_set().vkeys();
  const out: string[] = [];
  if (!vkeys) return out;
  for (let i = 0; i < vkeys.len(); i++) out.push(toKeyHashHex(vkeys.get(i).vkey().public_key()));
  return out;
}

/**
 * Merge a signer's partial-sign payload (witness-set-only hex or a full tx)
 * into the stored tx: dedupe by key hash, verify each new witness against the
 * core-cst hash of the ORIGINAL body (the exact bytes the wallet signed), then
 * merge WITHOUT re-encoding the body.
 */
export function mergeSignerWitnesses(
  originalTxHex: string,
  signedPayloadHex: string,
): { txHex: string; invalidVkeyPubKeysHex: string[]; addedKeyHashes: string[] } {
  const originalTx = csl.Transaction.from_hex(originalTxHex);

  // Key hashes already witnessed by earlier co-signers — don't re-verify those.
  const existingKeyHashes = new Set<string>();
  const existingVkeys = originalTx.witness_set().vkeys();
  if (existingVkeys) {
    for (let i = 0; i < existingVkeys.len(); i++) {
      existingKeyHashes.add(
        toKeyHashHex(existingVkeys.get(i).vkey().public_key()),
      );
    }
  }

  const incomingVkeys = extractVkeyWitnesses(signedPayloadHex);
  const newVkeys = csl.Vkeywitnesses.new();
  const seen = new Set<string>();
  const addedKeyHashes: string[] = [];
  for (let i = 0; i < incomingVkeys.len(); i++) {
    const witness = incomingVkeys.get(i);
    const keyHash = toKeyHashHex(witness.vkey().public_key());
    if (existingKeyHashes.has(keyHash) || seen.has(keyHash)) continue;
    seen.add(keyHash);
    addedKeyHashes.push(keyHash);
    newVkeys.add(witness);
  }

  const bodyHashBytes = Buffer.from(resolveTxHash(originalTxHex), "hex");
  const invalidVkeyPubKeysHex: string[] = [];
  for (let i = 0; i < newVkeys.len(); i++) {
    const witness = newVkeys.get(i);
    const pubKey = witness.vkey().public_key();
    if (!pubKey.verify(bodyHashBytes, witness.signature())) {
      invalidVkeyPubKeysHex.push(toPubKeyHex(pubKey));
    }
  }

  // addVKeyWitnessSetToTransaction parses with the same (core-cst) serializer
  // used to build the tx and preserves the original body bytes, so the
  // persisted/submitted body hash stays equal to what every signer signed.
  let txHex = originalTxHex;
  if (newVkeys.len() > 0) {
    const newWitnessSet = csl.TransactionWitnessSet.new();
    newWitnessSet.set_vkeys(newVkeys);
    txHex = addVKeyWitnessSetToTransaction(originalTxHex, newWitnessSet.to_hex());
  }

  return { txHex, invalidVkeyPubKeysHex, addedKeyHashes };
}

/**
 * Removes VKey witnesses whose key hash is not required by any native script
 * in the transaction's witness set. Prevents `InvalidWitnessesUTXOW` rejections
 * from the Conway ledger when a wallet returns extraneous witnesses during
 * partial signing. Non-multisig txs are returned unchanged.
 */
export function filterWitnessesToScripts(txHex: string): string {
  const tx = csl.Transaction.from_hex(txHex);
  const witnessSet = tx.witness_set();

  const nativeScripts = witnessSet.native_scripts();
  if (!nativeScripts || nativeScripts.len() === 0) {
    return txHex;
  }

  const allowedKeyHashes = new Set<string>();
  for (let i = 0; i < nativeScripts.len(); i++) {
    const decoded = decodeNativeScriptFromCsl(nativeScripts.get(i));
    for (const kh of collectSigKeyHashes(decoded)) {
      allowedKeyHashes.add(kh.toLowerCase());
    }
  }

  if (allowedKeyHashes.size === 0) {
    return txHex;
  }

  const existingVkeys = witnessSet.vkeys();
  if (!existingVkeys || existingVkeys.len() === 0) {
    return txHex;
  }

  // Pub keys (by hex) whose key hash is required by a native script — keep only
  // these. Analysis is read-only via core-csl; the rebuild below is core-cst.
  const allowedPubKeyHexes = new Set<string>();
  let removed = 0;
  for (let i = 0; i < existingVkeys.len(); i++) {
    const pub = existingVkeys.get(i).vkey().public_key();
    if (allowedKeyHashes.has(toKeyHashHex(pub))) {
      allowedPubKeyHexes.add(toPubKeyHex(pub));
    } else {
      removed += 1;
    }
  }

  if (removed === 0) {
    return txHex;
  }

  // Drop the extraneous vkeys WITHOUT re-encoding the body: rebuild the witness
  // set with core-cst, which preserves the original body bytes.
  const cstTx = CstTransaction.fromCbor(TxCBOR(txHex));
  const cstWitnessSet = cstTx.witnessSet();
  const cstVkeys = cstWitnessSet.vkeys();
  if (!cstVkeys) {
    return txHex;
  }
  const keptVkeys = [...cstVkeys.values()].filter((vkw) =>
    allowedPubKeyHexes.has(cstVkeyPubKeyHex(vkw)),
  );
  cstWitnessSet.setVkeys(
    CborSet.fromCore(
      keptVkeys.map((vkw) => vkw.toCore()),
      VkeyWitness.fromCore,
    ),
  );
  cstTx.setWitnessSet(cstWitnessSet);
  return cstTx.toCbor();
}
