import { sessionRoute } from "@/lib/api/route";
import type { CancelTxResponse } from "@/lib/api/types";
import { asNetwork } from "@/lib/config";
import { MSG } from "@/lib/constants";
import { cancelPendingTransaction } from "@/lib/db/transactions";
import { BadRequestError, ConflictError } from "@/lib/errors";
import { confirmIfOnChain } from "@/lib/reconciliation/onChain";
import { loadPendingTxForSigner } from "@/lib/tx";

/**
 * Cancel a pending transaction that already has signatures. Frees the
 * one-pending slot so a new build can start, while keeping payout/payment
 * rows and queued-task holds until the spend TTL expires off-chain or the
 * hash is confirmed on-chain. Unsigned builds use DELETE instead.
 *
 * An in-flight app co-sign refuses with 409 until the intent window ends.
 */
export const POST = sessionRoute<{ txId: string }>(
  async (_req, { params, session }) => {
    const { txId } = params;
    const { tx, treasury } = await loadPendingTxForSigner(txId, session.wallet);

    if (await confirmIfOnChain(tx, asNetwork(treasury.network))) {
      throw new ConflictError(MSG.txAlreadyOnChain);
    }

    if (tx.signed_addresses.length === 0) {
      throw new BadRequestError(MSG.txNotSigned);
    }

    if (!(await cancelPendingTransaction(txId))) {
      throw new ConflictError(MSG.txNotPending);
    }

    return { canceled: true } satisfies CancelTxResponse;
  },
);
