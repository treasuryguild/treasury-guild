import { sessionRoute } from "@/lib/api/route";
import type { DeleteTxResponse } from "@/lib/api/types";
import { MSG } from "@/lib/constants";
import { deletePendingTransaction } from "@/lib/db/transactions";
import { ConflictError } from "@/lib/errors";
import { loadPendingTxForSigner } from "@/lib/tx";

/**
 * Delete a pending transaction. Any signer on its spending path may do
 * this: a pending tx blocks the treasury (one pending transaction per
 * wallet), so signers need a way to clear a stale or mistaken build without waiting
 * for enough rejections to kill it.
 *
 * Queued tasks are released back to `payable` in the same database step
 * as the delete; `payouts` and `mints` rows cascade away with the
 * transaction.
 */
export const DELETE = sessionRoute<{ txId: string }>(
  async (_req, { params, session }) => {
    const { txId } = params;
    await loadPendingTxForSigner(txId, session.wallet);

    // Guard on state again so a concurrent submit can't be wiped out.
    if (!(await deletePendingTransaction(txId))) throw new ConflictError(MSG.txNotPending);

    return { deleted: true } satisfies DeleteTxResponse;
  },
);
