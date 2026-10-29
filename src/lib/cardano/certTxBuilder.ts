// Shared MeshTxBuilder setup for certificate / vote transactions: spend
// fee UTxOs from the treasury with the payment script, change back, then
// let the caller attach certificates or votes (and their scripts).
import "server-only";

import type { IFetcher } from "@meshsdk/common";
import { MeshTxBuilder } from "@meshsdk/core";
import { resolveTxHash } from "@meshsdk/core-cst";

import { LOVELACE } from "@/lib/assets";
import type { Network } from "@/lib/config";
import { networkName } from "@/lib/config";
import { selectUtxos } from "./utxoSelect";

/** Fee / deposit headroom for a certificate or vote (register needs 2 ADA stake deposit). */
const CERT_HEADROOM = 3_000_000n;

export async function completeCertTx(opts: {
  treasuryAddress: string;
  paymentScriptCbor: string;
  network: Network;
  provider: IFetcher;
  /** Extra lovelace needed beyond fees (stake/DRep deposits). */
  depositLovelace?: bigint;
  apply: (txBuilder: MeshTxBuilder) => void;
}): Promise<{ unsignedTxHex: string; txHash: string }> {
  const deposit = opts.depositLovelace ?? 0n;
  const needed = new Map<string, bigint>([[LOVELACE, CERT_HEADROOM + deposit]]);
  const utxos = await opts.provider.fetchAddressUTxOs(opts.treasuryAddress);
  const { selected, shortfall } = selectUtxos(utxos, needed, 0n);
  if (shortfall) {
    throw new Error(
      `Insufficient treasury funds for certificates (need ~${(CERT_HEADROOM + deposit).toString()} lovelace incl. fees)`,
    );
  }

  const txBuilder = new MeshTxBuilder({ fetcher: opts.provider, verbose: false });
  txBuilder.setNetwork(networkName(opts.network));

  for (const utxo of selected) {
    txBuilder
      .txIn(
        utxo.input.txHash,
        utxo.input.outputIndex,
        utxo.output.amount,
        utxo.output.address,
      )
      .txInScript(opts.paymentScriptCbor);
  }

  opts.apply(txBuilder);
  txBuilder.changeAddress(opts.treasuryAddress);

  const unsignedTxHex = await txBuilder.complete();
  return { unsignedTxHex, txHash: resolveTxHash(unsignedTxHex) };
}
