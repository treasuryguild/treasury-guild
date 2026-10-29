/**
 * CIP-0146 discovery: reconstruct an importable treasury from an on-chain
 * label-1854 registration plus the native script witnessed on the
 * registration transaction.
 *
 * Unlike multisig's flat-script-only importer, candidates are accepted when
 * `decodeTreasuryCbor` recognises them (plain / clawback / lock-until /
 * cosigner). Addresses are never synthesised as enterprise placeholders —
 * the import UI fills wallets from community members by key hash.
 */
import "server-only";

import { deserializeAddress, serializeNativeScript } from "@meshsdk/core";

import type { Network } from "@/lib/config";
import { BadRequestError } from "@/lib/errors";
import { isRecord } from "@/lib/guards";
import {
  joinMetadataString,
  METADATA_LABEL_1854,
  participantsInclude,
  type Label1854LookupItem,
  type Label1854Metadata,
} from "./cip146Registration";
import { csl } from "./csl";
import { decodeTreasuryCbor, type DecodedTreasuryScript } from "./treasuryImport";

export type RegistrationScriptCandidate = {
  address: string;
  scriptHash: string;
  scriptCbor: string;
  stakeCredentialHash: string | null;
};

export type DiscoveredTreasury = {
  txHash: string;
  address: string;
  scriptCbor: string;
  stakeCredentialHash: string | null;
  name: string;
  description: string;
  participants: Record<string, { name: string }>;
  decoded: DecodedTreasuryScript;
};

/** Parse a label-1854 map value from Koios /tx_metadata into our lookup shape. */
export function parseLabel1854Metadata(value: unknown): Label1854Metadata | null {
  if (!isRecord(value) || !Array.isArray(value.types)) return null;
  const types = value.types.filter((t): t is number => typeof t === "number");
  if (types.length === 0) return null;
  const participants: Label1854Metadata["participants"] = {};
  if (isRecord(value.participants)) {
    for (const [hash, info] of Object.entries(value.participants)) {
      if (!/^[0-9a-f]{56}$/i.test(hash)) continue;
      participants[hash.toLowerCase()] = {
        name: joinMetadataString(isRecord(info) ? info.name : ""),
      };
    }
  }
  const out: Label1854Metadata = { types };
  const name = joinMetadataString(value.name);
  const description = joinMetadataString(value.description);
  if (name) out.name = value.name as string | string[];
  if (description) out.description = value.description as string | string[];
  if (Object.keys(participants).length > 0) out.participants = participants;
  return out;
}

export function lookupItemsFromMetadata(
  byHash: Map<string, Record<string, unknown>>,
): Label1854LookupItem[] {
  const items: Label1854LookupItem[] = [];
  for (const [tx_hash, metadata] of byHash) {
    const raw = metadata[METADATA_LABEL_1854] ?? metadata["1854"];
    const json_metadata = parseLabel1854Metadata(raw);
    if (!json_metadata?.participants || Object.keys(json_metadata.participants).length === 0) {
      continue;
    }
    items.push({ tx_hash, json_metadata });
  }
  return items;
}

/** Filter registrations that list any of the supplied participant hashes. */
export function filterRegistrationsByHashes(
  items: readonly Label1854LookupItem[],
  pubKeyHashes: readonly string[],
): Label1854LookupItem[] {
  const wanted = new Set(pubKeyHashes.map((h) => h.toLowerCase()));
  return items.filter((item) => {
    const participants = item.json_metadata?.participants;
    if (!participants) return false;
    return Object.keys(participants).some((h) => wanted.has(h.toLowerCase()));
  });
}

function addressParts(address: string): {
  scriptHash: string | null;
  stakeCredentialHash: string | null;
} {
  try {
    const parts = deserializeAddress(address);
    const scriptHash = parts.scriptHash ? parts.scriptHash.toLowerCase() : null;
    const stakeCredentialHash =
      (parts.stakeScriptCredentialHash || parts.stakeCredentialHash || null)?.toLowerCase() ?? null;
    return { scriptHash, stakeCredentialHash };
  } catch {
    return { scriptHash: null, stakeCredentialHash: null };
  }
}

/** Native-script CBOR hex strings from a transaction's witness set. */
export function nativeScriptsFromTxCbor(txCbor: string): string[] {
  const tx = csl.Transaction.from_hex(txCbor);
  const nativeScripts = tx.witness_set().native_scripts();
  if (!nativeScripts || nativeScripts.len() === 0) return [];
  const out: string[] = [];
  const seen = new Set<string>();
  for (let i = 0; i < nativeScripts.len(); i++) {
    const hex = nativeScripts.get(i).to_hex().toLowerCase();
    if (seen.has(hex)) continue;
    seen.add(hex);
    out.push(hex);
  }
  return out;
}

/** Script-payment addresses from inputs then outputs (outputs first for self-spends). */
export function scriptAddressesFromTxCbor(txCbor: string): string[] {
  const body = csl.Transaction.from_hex(txCbor).body();
  const addresses: string[] = [];
  const seen = new Set<string>();
  const push = (address: string) => {
    if (seen.has(address)) return;
    const { scriptHash } = addressParts(address);
    if (!scriptHash) return;
    seen.add(address);
    addresses.push(address);
  };
  const outputs = body.outputs();
  for (let i = 0; i < outputs.len(); i++) {
    push(outputs.get(i).address().to_bech32());
  }
  const inputs = body.inputs();
  // Inputs do not carry addresses in the body; callers that only have CBOR
  // still get change-output candidates, which app-built registrations use.
  void inputs;
  return addresses;
}

/**
 * Pair witnessed native scripts with script-payment addresses seen on the
 * registration transaction (change output first).
 */
export function resolveRegistrationCandidates(txCbor: string): RegistrationScriptCandidate[] {
  const scripts = nativeScriptsFromTxCbor(txCbor);
  if (scripts.length === 0) return [];
  const byHash = new Map<string, string>();
  for (const scriptCbor of scripts) {
    try {
      const hash = csl.NativeScript.from_hex(scriptCbor).hash().to_hex().toLowerCase();
      byHash.set(hash, scriptCbor);
    } catch {
      // Skip undecodable witnesses.
    }
  }
  const candidates: RegistrationScriptCandidate[] = [];
  const seen = new Set<string>();
  for (const address of scriptAddressesFromTxCbor(txCbor)) {
    const { scriptHash, stakeCredentialHash } = addressParts(address);
    if (!scriptHash || seen.has(scriptHash)) continue;
    const scriptCbor = byHash.get(scriptHash);
    if (!scriptCbor) continue;
    seen.add(scriptHash);
    candidates.push({ address, scriptHash, scriptCbor, stakeCredentialHash });
  }
  return candidates;
}

/**
 * Pick the candidate whose payment keys are covered by the registration
 * participants and whose derived address equals the on-chain address.
 */
export function buildImportFromRegistration(
  item: Label1854LookupItem,
  candidates: readonly RegistrationScriptCandidate[],
  network: Network,
): DiscoveredTreasury {
  const meta = item.json_metadata;
  if (!meta?.participants) {
    throw new BadRequestError("Registration has no participants");
  }
  const participantHashes = Object.keys(meta.participants);

  for (const candidate of candidates) {
    let decoded: DecodedTreasuryScript;
    try {
      decoded = decodeTreasuryCbor(candidate.scriptCbor);
    } catch {
      continue;
    }
    if (!participantsInclude(item, decoded.keyHashes)) continue;

    const { address: derived } = serializeNativeScript(
      decoded.paymentScript,
      candidate.stakeCredentialHash ?? undefined,
      network,
      true,
    );
    if (derived !== candidate.address) continue;

    // Payment keys must all be listed; extras (stake/drep) are fine.
    if (!decoded.keyHashes.every((h) =>
      participantHashes.some((p) => p.toLowerCase() === h.toLowerCase()),
    )) {
      continue;
    }

    const participants: Record<string, { name: string }> = {};
    for (const [hash, info] of Object.entries(meta.participants)) {
      participants[hash.toLowerCase()] = { name: info.name };
    }

    return {
      txHash: item.tx_hash.toLowerCase(),
      address: candidate.address,
      scriptCbor: decoded.scriptCbor,
      stakeCredentialHash: candidate.stakeCredentialHash,
      name: joinMetadataString(meta.name),
      description: joinMetadataString(meta.description),
      participants,
      decoded,
    };
  }

  throw new BadRequestError(
    "Could not reconstruct a Treasury Guild script from this registration transaction",
  );
}
