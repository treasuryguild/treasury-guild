import { sessionRoute } from "@/lib/api/route";
import type { SubmitTxResponse } from "@/lib/api/types";
import { getProvider } from "@/lib/cardano/provider";
import { pathRule } from "@/lib/cardano/spendingPaths";
import { describeRule, thresholdReached } from "@/lib/cardano/thresholds";
import { filterWitnessesToScripts } from "@/lib/cardano/txSignUtils";
import { asNetwork } from "@/lib/config";
import { markTransactionSubmitted } from "@/lib/db/transactions";
import { BadRequestError } from "@/lib/errors";
import { loadPendingTxForSigner } from "@/lib/tx";

export const POST = sessionRoute<{ txId: string }>(
  async (_req, { params, session }) => {
    const { txId } = params;
    const { tx, treasury, signers } = await loadPendingTxForSigner(
      txId,
      session.wallet,
    );
    // Only signatures that count on the transaction's own spending path.
    const rule = pathRule(treasury, signers, tx.spending_path);
    if (!thresholdReached(rule, tx.signed_addresses)) {
      throw new BadRequestError(
        `Not enough signatures: ${tx.signed_addresses.length} collected, ${describeRule(rule)} required`,
      );
    }

    // Strip extraneous wallet witnesses (Conway InvalidWitnessesUTXOW guard)
    const txHex = filterWitnessesToScripts(tx.tx_cbor);
    const txHash = await getProvider(asNetwork(treasury.network)).submitTx(txHex);

    // The tx is on the network from here on: a failed bookkeeping write is
    // logged with the hash so it can be repaired by hand.
    try {
      await markTransactionSubmitted(txId, txHash, txHex);
    } catch (err) {
      console.error(`tx ${txId} submitted as ${txHash} but bookkeeping failed`, err);
      throw err;
    }

    return { txHash } satisfies SubmitTxResponse;
  },
);
