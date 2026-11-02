// Update or delete a bridge/swap conversion episode.
import { parseJson, sessionRoute } from "@/lib/api/route";
import { patchConversionSchema } from "@/lib/api/schemas";
import type { OkResponse } from "@/lib/api/types";
import { requireAdmin } from "@/lib/authz";
import { conversionFeeRows, conversionProofRows } from "@/lib/conversions/body";
import {
  deleteConversion,
  requireConversion,
  updateConversion,
} from "@/lib/db/conversions";
import { enforceRateLimit } from "@/lib/db/rateLimit";

export const PATCH = sessionRoute<{ id: string }>(async (req, { params, session }) => {
  const body = await parseJson(req, patchConversionSchema);
  const row = await requireConversion(params.id);
  await requireAdmin(row.community_id, session.wallet);
  await enforceRateLimit("conversionWrite", session.wallet);
  await updateConversion(row.id, {
    kind: body.kind,
    sent_amount: body.sentAmount,
    sent_asset_label: body.sentAssetLabel,
    sent_chain: body.sentChain,
    sent_address: body.sentAddress ?? null,
    note: body.note ?? null,
    fees: conversionFeeRows(body.fees),
    proofs: conversionProofRows(body.proofs),
  });
  return { ok: true } satisfies OkResponse;
});

export const DELETE = sessionRoute<{ id: string }>(async (_req, { params, session }) => {
  const row = await requireConversion(params.id);
  await requireAdmin(row.community_id, session.wallet);
  await deleteConversion(row.id);
  return { ok: true } satisfies OkResponse;
});
