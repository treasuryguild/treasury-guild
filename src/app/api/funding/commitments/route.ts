// Add what a funding source committed: a one-off total, a recurring amount,
// or a schedule (whose periods are saved with POST …/schedule). Amounts arrive
// in display units and are scaled here with each token's real decimals.
import { parseJson, sessionRoute } from "@/lib/api/route";
import { fundingCommitmentSchema } from "@/lib/api/schemas";
import type { FundingCreatedResponse } from "@/lib/api/types";
import { createFundingCommitment } from "@/lib/db/funding";
import { requireFundingSourceAdmin, resolveFundingTokens } from "@/lib/funding/access";
import { toFundingAmounts } from "@/lib/funding/amounts";

export const POST = sessionRoute(async (req, { session }) => {
  const body = await parseJson(req, fundingCommitmentSchema);
  const source = await requireFundingSourceAdmin(body.sourceId, session.wallet);
  const tokens = await resolveFundingTokens(source.community_id, body.amounts.map((a) => a.unit));
  const commitment = await createFundingCommitment({
    source_id: source.id,
    community_id: source.community_id,
    name: body.name.trim(),
    url: body.url ?? null,
    note: body.note?.trim() || null,
    kind: body.kind,
    cadence: body.kind === "one_off" ? null : body.cadence!,
    starts_on: body.startsOn ? `${body.startsOn}-01` : null,
    ends_on: body.endsOn ? `${body.endsOn}-01` : null,
    amounts: toFundingAmounts(body.amounts, tokens),
    created_by: session.wallet,
  });
  return { id: commitment.id } satisfies FundingCreatedResponse;
});
