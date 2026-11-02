// Create a bridge/swap conversion episode on a treasury or float inflow.
import { parseJson, sessionRoute } from "@/lib/api/route";
import { createConversionSchema } from "@/lib/api/schemas";
import type { ConversionCreatedResponse } from "@/lib/api/types";
import { requireAdmin } from "@/lib/authz";
import { conversionFeeRows, conversionProofRows } from "@/lib/conversions/body";
import { communityIdForInflow, createConversion } from "@/lib/db/conversions";
import { enforceRateLimit } from "@/lib/db/rateLimit";

export const POST = sessionRoute(async (req, { session }) => {
  const body = await parseJson(req, createConversionSchema);
  const communityId = await communityIdForInflow({
    incomingTxHash: body.incomingTxHash,
    floatIncomingTxHash: body.floatIncomingTxHash,
  });
  await requireAdmin(communityId, session.wallet);
  await enforceRateLimit("conversionWrite", session.wallet);

  const row = await createConversion({
    community_id: communityId,
    kind: body.kind,
    incoming_tx_hash: body.incomingTxHash ?? null,
    float_incoming_tx_hash: body.floatIncomingTxHash ?? null,
    sent_amount: body.sentAmount,
    sent_asset_label: body.sentAssetLabel,
    sent_chain: body.sentChain,
    sent_address: body.sentAddress ?? null,
    note: body.note ?? null,
    created_by: session.wallet,
    fees: conversionFeeRows(body.fees),
    proofs: conversionProofRows(body.proofs),
  });
  return { id: row.id } satisfies ConversionCreatedResponse;
});
