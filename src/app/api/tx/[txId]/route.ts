import { sessionRoute } from "@/lib/api/route";
import type { DeleteTxResponse } from "@/lib/api/types";
import { asNetwork } from "@/lib/config";
import { MSG } from "@/lib/constants";
import { deletePendingTransaction } from "@/lib/db/transactions";
import { ConflictError } from "@/lib/errors";
import { confirmIfOnChain } from "@/lib/reconciliation/onChain";
import { loadPendingTxForSigner } from "@/lib/tx";

/**
 * Delete a pending transaction. Any signer on its spending path may do
 * this: a pending tx blocks the treasury (one pending transaction per
 * wallet), so signers need a way to clear a stale or mistaken build without waiting
 * for enough rejections to kill it.
 *
 * Queued tasks are released back to `payable` in the same database step
 * as the delete; `payouts` and `mints` rows cascade away with the
 * transaction. A pending row whose hash is already on-chain is confirmed
 * instead, so its tasks stay paid.
 */
export const DELETE = sessionRoute<{ txId: string }>(
  async (_req, { params, session }) => {
    const { txId } = params;
    const { tx, treasury } = await loadPendingTxForSigner(txId, session.wallet);

    if (await confirmIfOnChain(tx, asNetwork(treasury.network))) {
      throw new ConflictError(MSG.txAlreadyOnChain);
    }

    // Guard on state again so a concurrent submit can't be wiped out.
    if (!(await deletePendingTransaction(txId))) throw new ConflictError(MSG.txNotPending);

    return { deleted: true } satisfies DeleteTxResponse;
  },
);
