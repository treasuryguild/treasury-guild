/**
 * Server helpers that load CIP-0146 registrations from Koios and resolve
 * the witnessed native script of a registration transaction.
 */
import "server-only";

import { resolveTxHash } from "@meshsdk/core-cst";
import type { Network } from "@/lib/config";
import { BadRequestError, NotFoundError } from "@/lib/errors";
import {
  filterRegistrationsByHashes,
  lookupItemsFromMetadata,
  resolveRegistrationCandidates,
  buildImportFromRegistration,
  type DiscoveredTreasury,
} from "./cip146Discovery";
import {
  METADATA_LABEL_1854,
  type Label1854LookupItem,
} from "./cip146Registration";
import { txCborBulk, txMetadataBulk, txsByMetalabel } from "./koios";

/** Label-1854 registrations that list any of the given participant hashes. */
export async function lookupRegistrations(
  network: Network,
  pubKeyHashes: readonly string[],
): Promise<Label1854LookupItem[]> {
  const hashes = [...new Set(pubKeyHashes.map((h) => h.toLowerCase()).filter((h) => /^[0-9a-f]{56}$/.test(h)))];
  if (hashes.length === 0) return [];
  const txHashes = await txsByMetalabel(network, METADATA_LABEL_1854);
  if (txHashes.length === 0) return [];
  const metadata = await txMetadataBulk(network, txHashes);
  return filterRegistrationsByHashes(lookupItemsFromMetadata(metadata), hashes);
}

/** Reconstruct a Treasury Guild import from a registration transaction. */
export async function resolveRegistrationImport(
  network: Network,
  txHash: string,
): Promise<DiscoveredTreasury> {
  const hash = txHash.toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hash)) {
    throw new BadRequestError("Invalid registration transaction hash");
  }
  const [cbors, metadata] = await Promise.all([
    txCborBulk(network, [hash]),
    txMetadataBulk(network, [hash]),
  ]);
  const cbor = cbors.get(hash);
  if (!cbor || resolveTxHash(cbor) !== hash) {
    throw new NotFoundError("Registration transaction not found on chain");
  }
  const items = lookupItemsFromMetadata(metadata);
  const item = items.find((i) => i.tx_hash.toLowerCase() === hash);
  if (!item) {
    throw new BadRequestError("Transaction has no CIP-0146 (label 1854) registration metadata");
  }
  return buildImportFromRegistration(item, resolveRegistrationCandidates(cbor), network);
}
