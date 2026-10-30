import { sessionRoute } from "@/lib/api/route";
import type { DeleteTxResponse } from "@/lib/api/types";
import { asNetwork } from "@/lib/config";
import { MSG } from "@/lib/constants";
import { deletePendingTransaction } from "@/lib/db/transactions";
import { ConflictError } from "@/lib/errors";
import { confirmIfOnChain } from "@/lib/reconciliation/onChain";
import { loadPendingTxForSigner } from "@/lib/tx";

/**
 * Delete a pending transaction that has no signatures yet. Any signer on its
 * spending path may do this: a pending tx blocks the treasury (one pending
 * transaction per wallet), so signers need a way to clear a stale or mistaken
 * unsigned build without waiting for enough rejections to kill it.
 *
 * Once any signature is recorded, DELETE is refused — use POST
 * `/api/tx/[txId]/cancel` instead (state Canceled: frees the slot, keeps
 * reservations until TTL or on-chain confirm). The RPC refuses under the
 * same row lock as `add_signature`.
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

    if (tx.signed_addresses.length > 0) {
      throw new ConflictError(MSG.txHasSignatures);
    }

    // Guard on state / a racing signature again inside the RPC.
    if (!(await deletePendingTransaction(txId))) throw new ConflictError(MSG.txNotPending);

    return { deleted: true } satisfies DeleteTxResponse;
  },
);
