import { parseJson, sessionRoute } from "@/lib/api/route";
import { incomingDetailsSchema } from "@/lib/api/schemas";
import type { OkResponse } from "@/lib/api/types";
import { requireAdmin } from "@/lib/authz";
import { loadFundingCommitment, loadFundingSource } from "@/lib/db/funding";
import { incomingHasReconciliation, loadIncomingWithTreasury, saveIncomingDetails } from "@/lib/db/incoming";
import { BadRequestError, NotFoundError } from "@/lib/errors";

export const PATCH = sessionRoute(async (req, { session }) => {
  const { txHash, incomingType, requiresReconciliation, note, fundingSourceId, fundingCommitmentId } = await parseJson(
    req,
    incomingDetailsSchema,
  );
  const incoming = await loadIncomingWithTreasury(txHash);
  const communityId = incoming.treasuries.community_id;
  await requireAdmin(communityId, session.wallet);

  // The whole inflow is tied to one funding source (and optionally one of its
  // commitments). guard_incoming_funding enforces the same rules in the DB.
  if (fundingSourceId) {
    if (incoming.from_treasury_id) {
      throw new BadRequestError("A transfer between your treasuries cannot be tied to a funding source");
    }
    const source = await loadFundingSource(fundingSourceId);
    if (!source || source.community_id !== communityId) throw new NotFoundError("Funding source not found");
    if (fundingCommitmentId) {
      const commitment = await loadFundingCommitment(fundingCommitmentId);
      if (!commitment || commitment.source_id !== source.id) {
        throw new BadRequestError("That commitment belongs to another funding source");
      }
    }
  }

  const reconciled = await incomingHasReconciliation(txHash);

  await saveIncomingDetails(txHash, {
    incoming_type: incomingType,
    requires_reconciliation: reconciled ? true : requiresReconciliation,
    note: note?.trim() || null,
    matched: reconciled ? true : !requiresReconciliation,
    // Left out of the body: the tag stays as it is.
    ...(fundingSourceId !== undefined && {
      funding_source_id: fundingSourceId,
      funding_commitment_id: fundingSourceId ? fundingCommitmentId ?? null : null,
    }),
  });
  return { ok: true } satisfies OkResponse;
});
