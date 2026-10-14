// Builds a native-script mint transaction from a multisig treasury.
// The treasury's own multisig script (optionally time-lock wrapped) is the
// forge policy, so the same signers/threshold authorise the mint as a payout.
import "server-only";

import { MeshTxBuilder } from "@meshsdk/core";
import type { IFetcher } from "@meshsdk/common";
import { resolveTxHash } from "@meshsdk/core-cst";
import { networkName, type Network } from "@/lib/config";
import { LOVELACE } from "@/lib/assets";
import { buildMessageMetadata, CIP20_LABEL } from "./metadata";
import { CIP25_LABEL } from "./mintMetadata";
import { minLovelaceForOutput, selectUtxos } from "./utxoSelect";

export interface MintAssetSpec {
  assetNameHex: string;
  /** On-chain base units (1 for an NFT). */
  quantity: bigint;
}

export interface BuildMintResult {
  unsignedTxHex: string;
  txHash: string;
  /** The single output carrying the minted bundle (lovelace bumped to min-UTxO). */
  output: { address: string; assets: { unit: string; quantity: bigint }[] };
}

/** Fee + change min-ADA headroom for UTxO selection. */
const SELECTION_HEADROOM = 3_000_000n;

export async function buildMintTx(opts: {
  treasuryAddress: string;
  /** The treasury multisig script CBOR (spends the inputs). */
  spendScriptCbor: string;
  /** The forge script CBOR (same script, or time-lock wrapped). */
  forgeScriptCbor: string;
  policyId: string;
  network: Network;
  provider: IFetcher;
  assets: MintAssetSpec[];
  recipient: string;
  /** Label-721 object as built by buildCip25Metadata. */
  metadata721: object;
  /** CIP-20 human message. */
  message: string;
  /** Absolute slot the forge policy closes at (sets the tx TTL). */
  lockSlot?: number | null;
  /** The treasury's lock slot when its path needs the validity interval to start there. */
  validFromSlot?: number | null;
}): Promise<BuildMintResult> {
  const {
    treasuryAddress,
    spendScriptCbor,
    forgeScriptCbor,
    policyId,
    network,
    provider,
    assets,
    recipient,
    metadata721,
    message,
    lockSlot,
  } = opts;

  if (assets.length === 0) throw new Error("Nothing to mint");
  const seen = new Set<string>();
  for (const a of assets) {
    if (!/^[0-9a-f]{2,64}$/.test(a.assetNameHex)) {
      throw new Error(`Invalid asset name hex: ${a.assetNameHex}`);
    }
    if (a.quantity <= 0n) throw new Error("Mint quantity must be positive");
    if (seen.has(a.assetNameHex)) {
      throw new Error("Duplicate asset name in mint");
    }
    seen.add(a.assetNameHex);
  }

  const nameBytes = assets.reduce((sum, a) => sum + a.assetNameHex.length / 2, 0);
  const minLovelace = minLovelaceForOutput({
    policies: 1,
    assets: assets.length,
    totalNameBytes: nameBytes,
  });
  const output = {
    address: recipient,
    assets: [
      { unit: LOVELACE, quantity: minLovelace },
      ...assets.map((a) => ({
        unit: policyId + a.assetNameHex,
        quantity: a.quantity,
      })),
    ],
  };

  const utxos = await provider.fetchAddressUTxOs(treasuryAddress);
  const { selected, shortfall } = selectUtxos(
    utxos,
    new Map([[LOVELACE, minLovelace]]),
    SELECTION_HEADROOM,
  );
  if (shortfall) {
    const missing = shortfall.get(LOVELACE) ?? 0n;
    throw new Error(
      `Insufficient treasury funds: short ${missing.toString()} lovelace (incl. fee/min-UTxO headroom)`,
    );
  }

  const txBuilder = new MeshTxBuilder({ fetcher: provider, verbose: false });
  txBuilder.setNetwork(networkName(network));

  for (const utxo of selected) {
    txBuilder
      .txIn(
        utxo.input.txHash,
        utxo.input.outputIndex,
        utxo.output.amount,
        utxo.output.address,
      )
      .txInScript(spendScriptCbor);
  }

  for (const a of assets) {
    txBuilder
      .mint(a.quantity.toString(), policyId, a.assetNameHex)
      .mintingScript(forgeScriptCbor);
  }

  txBuilder
    .txOut(
      output.address,
      output.assets.map((a) => ({
        unit: a.unit,
        quantity: a.quantity.toString(),
      })),
    )
    .metadataValue(CIP25_LABEL, metadata721)
    .metadataValue(CIP20_LABEL, buildMessageMetadata(message))
    .changeAddress(treasuryAddress);

  const validFromSlot = opts.validFromSlot ?? null;
  if (validFromSlot !== null) {
    if (lockSlot !== undefined && lockSlot !== null && lockSlot <= validFromSlot) {
      throw new Error("The policy lock must end after the treasury's lock date");
    }
    txBuilder.invalidBefore(validFromSlot);
  }
  if (lockSlot !== undefined && lockSlot !== null) {
    // A time-locked policy is only valid for txs that expire before the lock.
    txBuilder.invalidHereafter(lockSlot);
  }

  const unsignedTxHex = await txBuilder.complete();
  const txHash = resolveTxHash(unsignedTxHex);

  return { unsignedTxHex, txHash, output };
}
