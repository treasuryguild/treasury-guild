import { parseJson, parseQuery, sessionRoute } from "@/lib/api/route";
import {
  reconcileMatchQuerySchema,
  reconcileMatchSchema,
} from "@/lib/api/schemas";
import type { MatchSuggestionsResponse, OkResponse } from "@/lib/api/types";
import { LOVELACE } from "@/lib/assets";
import { requireMember } from "@/lib/authz";
import {
  loadIncomingWithTreasury as loadIncoming,
  loadPayoutTreasury,
  markPayoutAdjusted,
  recordReconciliation,
} from "@/lib/db/incoming";
import { markTaskReconciled } from "@/lib/db/tasks";
import { isTreasurySigner } from "@/lib/db/treasuries";
import { ConflictError, ForbiddenError, NotFoundError } from "@/lib/errors";
import { suggestMatches } from "@/lib/reconciliation/match";

// GET: ranked suggestions for an incoming tx.
export const GET = sessionRoute(async (req, { session }) => {
  const { txHash } = parseQuery(req, reconcileMatchQuerySchema);
  const incoming = await loadIncoming(txHash);
  await requireMember(incoming.treasuries.community_id, session.wallet);

  const suggestions = await suggestMatches(incoming);
  return { suggestions } satisfies MatchSuggestionsResponse;
});

// POST: confirm a match.
export const POST = sessionRoute(async (req, { session }) => {
  const { txHash, payoutId, amount, unit, note } = await parseJson(
    req,
    reconcileMatchSchema,
  );
  const incoming = await loadIncoming(txHash);
  const treasury = incoming.treasuries;
  await requireMember(treasury.community_id, session.wallet);
  if (!incoming.requires_reconciliation) {
    throw new ConflictError("This incoming transaction does not require reconciliation");
  }
  if (incoming.matched) {
    throw new ConflictError("This incoming transaction is already reconciled");
  }

  // only treasury signers reconcile
  if (!(await isTreasurySigner(treasury.id, session.wallet))) {
    throw new ForbiddenError("Only treasury signers can reconcile");
  }

  // The payout comes from the body: it must be one this treasury paid, the
  // scope suggestMatches offers, or a signer could settle any community's.
  const payout = payoutId ? await loadPayoutTreasury(payoutId) : null;
  if (payoutId && (!payout || payout.treasury_id !== treasury.id)) {
    throw new NotFoundError("Payout not found for this treasury");
  }

  await recordReconciliation({
    txHash,
    payoutId: payoutId ?? null,
    amount,
    unit: unit || LOVELACE,
    note: note?.trim() || null,
    createdBy: session.wallet,
  });

  if (payoutId && payout) {
    await markPayoutAdjusted(payoutId);
    await markTaskReconciled(payout.task_id);
  }

  return { ok: true } satisfies OkResponse;
});
