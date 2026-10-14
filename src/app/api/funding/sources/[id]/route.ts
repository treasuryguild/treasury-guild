// Edit a funding source, or remove it with its commitments. Inflows tied to
// it stay in the treasury; they are only untagged.
import { parseJson, sessionRoute } from "@/lib/api/route";
import { deleteFundingSourceSchema, patchFundingSourceSchema } from "@/lib/api/schemas";
import type { OkResponse } from "@/lib/api/types";
import { deleteFundingSource, updateFundingSource } from "@/lib/db/funding";
import { BadRequestError } from "@/lib/errors";
import { requireFundingSourceAdmin } from "@/lib/funding/access";

export const PATCH = sessionRoute<{ id: string }>(async (req, { params, session }) => {
  const body = await parseJson(req, patchFundingSourceSchema);
  const source = await requireFundingSourceAdmin(params.id, session.wallet);
  await updateFundingSource(source.id, {
    ...(body.name !== undefined && { name: body.name.trim() }),
    ...(body.description !== undefined && { description: body.description?.trim() || null }),
    ...(body.url !== undefined && { url: body.url }),
  });
  return { ok: true } satisfies OkResponse;
});

export const DELETE = sessionRoute<{ id: string }>(async (req, { params, session }) => {
  const { confirmName } = await parseJson(req, deleteFundingSourceSchema);
  const source = await requireFundingSourceAdmin(params.id, session.wallet);
  if (confirmName.trim() !== source.name) throw new BadRequestError("Type the funding source's name exactly to confirm");
  await deleteFundingSource(source.id);
  return { ok: true } satisfies OkResponse;
});
