// Edit a commitment (its kind and cadence stay: remove and re-add to change
// them), or remove it. Inflows tied to it stay tied to its source.
import { parseJson, sessionRoute } from "@/lib/api/route";
import { patchFundingCommitmentSchema } from "@/lib/api/schemas";
import type { OkResponse } from "@/lib/api/types";
import { deleteFundingCommitment, updateFundingCommitment } from "@/lib/db/funding";
import { BadRequestError } from "@/lib/errors";
import { requireFundingCommitmentAdmin, resolveFundingTokens } from "@/lib/funding/access";
import { toFundingAmounts } from "@/lib/funding/amounts";

const QUARTER_MONTHS = ["01", "04", "07", "10"];

export const PATCH = sessionRoute<{ id: string }>(async (req, { params, session }) => {
  const body = await parseJson(req, patchFundingCommitmentSchema);
  const commitment = await requireFundingCommitmentAdmin(params.id, session.wallet);
  if (commitment.kind === "schedule" && (body.amounts || body.startsOn || body.endsOn)) {
    throw new BadRequestError("A schedule's amounts are set per period");
  }
  if (commitment.kind !== "recurring" && body.endsOn) throw new BadRequestError("Only a recurring commitment has an end month");
  if (commitment.kind === "recurring" && body.startsOn === null) throw new BadRequestError("Choose the first month");
  const startsOn = body.startsOn === undefined ? commitment.starts_on?.slice(0, 7) ?? null : body.startsOn;
  const endsOn = body.endsOn === undefined ? commitment.ends_on?.slice(0, 7) ?? null : body.endsOn;
  if (startsOn && endsOn && endsOn < startsOn) throw new BadRequestError("The last month comes before the first");
  if (commitment.cadence === "quarterly" && [startsOn, endsOn].some((m) => m && !QUARTER_MONTHS.includes(m.slice(5)))) {
    throw new BadRequestError("Quarterly periods start in January, April, July or October");
  }
  const amounts = body.amounts
    ? toFundingAmounts(body.amounts, await resolveFundingTokens(commitment.community_id, body.amounts.map((a) => a.unit)))
    : undefined;
  await updateFundingCommitment(commitment.id, {
    ...(body.name !== undefined && { name: body.name.trim() }),
    ...(body.url !== undefined && { url: body.url }),
    ...(body.note !== undefined && { note: body.note?.trim() || null }),
    ...(body.startsOn !== undefined && { starts_on: body.startsOn ? `${body.startsOn}-01` : null }),
    ...(body.endsOn !== undefined && { ends_on: body.endsOn ? `${body.endsOn}-01` : null }),
    ...(amounts && { amounts }),
  });
  return { ok: true } satisfies OkResponse;
});

export const DELETE = sessionRoute<{ id: string }>(async (_req, { params, session }) => {
  const commitment = await requireFundingCommitmentAdmin(params.id, session.wallet);
  await deleteFundingCommitment(commitment.id);
  return { ok: true } satisfies OkResponse;
});
