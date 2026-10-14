// Build a payout transaction for payable tasks: the checks and the unsigned
// transaction (planPayout), then the pending transaction with its payouts
// rows (persistPayout). Both live in src/lib/payout/build.ts, shared with
// the agent API's payout drafts.
import { parseJson, sessionRoute } from "@/lib/api/route";
import { buildPayoutSchema } from "@/lib/api/schemas";
import type { BuildPayoutResponse } from "@/lib/api/types";
import { persistPayout, planPayout } from "@/lib/payout/build";
import { builtTxResponse } from "@/lib/tx";

export const POST = sessionRoute(async (req, { session }) => {
  const { wallet } = session;
  const input = await parseJson(req, buildPayoutSchema);
  const plan = await planPayout(input, wallet);
  const txRow = await persistPayout(plan, wallet);
  return { ...builtTxResponse(txRow.id, plan.built) } satisfies BuildPayoutResponse;
});
