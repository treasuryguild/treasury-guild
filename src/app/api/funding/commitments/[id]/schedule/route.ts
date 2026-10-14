// POST: replace a schedule's periods, e.g. from a funder's release plan CSV. The
// browser sends display amounts; they are scaled here with each token's real
// decimals and saved in one statement, so a refused period keeps the old plan.
import { parseJson, sessionRoute } from "@/lib/api/route";
import { fundingScheduleSchema } from "@/lib/api/schemas";
import type { FundingScheduleResponse } from "@/lib/api/types";
import { saveFundingSchedule } from "@/lib/db/funding";
import { BadRequestError } from "@/lib/errors";
import { requireFundingCommitmentAdmin, resolveFundingTokens } from "@/lib/funding/access";
import { toFundingAmounts } from "@/lib/funding/amounts";

export const POST = sessionRoute<{ id: string }>(async (req, { params, session }) => {
  const { periods } = await parseJson(req, fundingScheduleSchema);
  const commitment = await requireFundingCommitmentAdmin(params.id, session.wallet);
  if (commitment.kind !== "schedule") throw new BadRequestError("Only a schedule has periods");
  const tokens = await resolveFundingTokens(commitment.community_id, periods.flatMap((p) => p.amounts.map((a) => a.unit)));
  const count = await saveFundingSchedule(commitment.id, periods.map((period) => ({
    startsOn: `${period.month}-01`,
    amounts: toFundingAmounts(period.amounts, tokens),
  })));
  return { periods: count } satisfies FundingScheduleResponse;
});
