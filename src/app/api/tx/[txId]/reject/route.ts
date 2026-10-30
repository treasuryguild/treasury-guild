import { sessionRoute } from "@/lib/api/route";
import type { RejectTxResponse } from "@/lib/api/types";
import { pathRule } from "@/lib/cardano/spendingPaths";
import { thresholdStillReachable } from "@/lib/cardano/thresholds";
import { asNetwork } from "@/lib/config";
import { MSG } from "@/lib/constants";
import { recordRejection } from "@/lib/db/transactions";
import { ConflictError } from "@/lib/errors";
import { confirmIfOnChain } from "@/lib/reconciliation/onChain";
import { loadPendingTxForSigner } from "@/lib/tx";

export const POST = sessionRoute<{ txId: string }>(
  async (_req, { params, session }) => {
    const { tx, treasury, signers } = await loadPendingTxForSigner(
      params.txId,
      session.wallet,
    );
    if (await confirmIfOnChain(tx, asNetwork(treasury.network))) {
      throw new ConflictError(MSG.txAlreadyOnChain);
    }
    if (
      tx.rejected_addresses.includes(session.wallet) ||
      tx.signed_addresses.includes(session.wallet)
    ) {
      throw new ConflictError("Already responded to this transaction");
    }

    const rejected = [...tx.rejected_addresses, session.wallet];
    // Reachability on the transaction's own spending path: a rejecting
    // co-signer kills a co-signed transaction, a rejecting base signer a
    // bypass one.
    const reachable = thresholdStillReachable(
      pathRule(treasury, signers, tx.spending_path),
      tx.signed_addresses,
      rejected,
    );

    // Guarded on the state and on the lists read above: a concurrent submit,
    // signature or rejection makes this a conflict (refetch and retry)
    // rather than overwriting it. A dead unsigned tx releases tasks; a dead
    // signed tx becomes Canceled (reservation held until TTL / confirm).
    if (!(await recordRejection({ tx, rejected, dead: !reachable }))) {
      throw new ConflictError(MSG.txChanged);
    }

    return { rejected: true, dead: !reachable } satisfies RejectTxResponse;
  },
);
