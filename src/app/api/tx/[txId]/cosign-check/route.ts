// The co-signer check as it stands now, for the transaction page: a member
// co-signer reads it before signing; everyone sees what the app decided.
import { sessionRoute } from "@/lib/api/route";
import type { CosignCheckResponse } from "@/lib/api/types";
import { SpendingPath } from "@/lib/constants";
import { runCosignerCheck } from "@/lib/cosigner/check";
import { loadCosignerDecisions } from "@/lib/db/cosigner";
import { BadRequestError } from "@/lib/errors";
import { loadTxContext } from "@/lib/tx";

export const GET = sessionRoute<{ txId: string }>(async (_req, { params, session }) => {
  const { tx, treasury } = await loadTxContext(params.txId, session.wallet);
  if (tx.spending_path !== SpendingPath.Cosigned) {
    throw new BadRequestError("Only a co-signed transaction has a co-signer check");
  }
  const [check, decisions] = await Promise.all([runCosignerCheck(tx, treasury), loadCosignerDecisions(tx.id)]);
  return { passed: check.passed, problems: check.problems, decisions } satisfies CosignCheckResponse;
});
