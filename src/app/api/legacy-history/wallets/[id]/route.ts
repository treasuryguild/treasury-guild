// Rename a previous wallet or change its address label, or remove it with
// all the history imported for it.
import { parseJson, sessionRoute } from "@/lib/api/route";
import { deleteLegacyWalletSchema, patchLegacyWalletSchema } from "@/lib/api/schemas";
import type { OkResponse } from "@/lib/api/types";
import { deleteLegacyWallet, updateLegacyWallet } from "@/lib/db/legacyHistory";
import { BadRequestError } from "@/lib/errors";
import { requireLegacyAddressNetwork, requireLegacyWalletAdmin } from "@/lib/legacyHistory/access";

export const PATCH = sessionRoute<{ id: string }>(async (req, { params, session }) => {
  const body = await parseJson(req, patchLegacyWalletSchema);
  const wallet = await requireLegacyWalletAdmin(params.id, session.wallet);
  if (body.address) await requireLegacyAddressNetwork(wallet.community_id, body.address);
  await updateLegacyWallet(wallet.id, {
    ...(body.name !== undefined && { name: body.name.trim() }),
    ...(body.address !== undefined && { address: body.address }),
  });
  return { ok: true } satisfies OkResponse;
});

export const DELETE = sessionRoute<{ id: string }>(async (req, { params, session }) => {
  const { confirmName } = await parseJson(req, deleteLegacyWalletSchema);
  const wallet = await requireLegacyWalletAdmin(params.id, session.wallet);
  if (confirmName.trim() !== wallet.name) {
    throw new BadRequestError("Type the wallet name exactly to confirm");
  }
  await deleteLegacyWallet(wallet.id);
  return { ok: true } satisfies OkResponse;
});
