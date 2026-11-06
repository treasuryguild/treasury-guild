// Rename a previous wallet or change its address label, or remove it with
// all the history imported for it.
import { parseJson, sessionRoute } from "@/lib/api/route";
import { deleteLegacyWalletSchema, patchLegacyWalletSchema } from "@/lib/api/schemas";
import type { OkResponse } from "@/lib/api/types";
import { deleteLegacyWallet, updateLegacyWallet } from "@/lib/db/legacyHistory";
import { BadRequestError } from "@/lib/errors";
import {
  requireLegacyAddressNetwork, requireLegacyWalletAdmin, resolveLegacyWalletScriptFields,
} from "@/lib/legacyHistory/access";

export const PATCH = sessionRoute<{ id: string }>(async (req, { params, session }) => {
  const body = await parseJson(req, patchLegacyWalletSchema);
  const wallet = await requireLegacyWalletAdmin(params.id, session.wallet);
  const patch: Parameters<typeof updateLegacyWallet>[1] = {};
  if (body.name !== undefined) patch.name = body.name.trim();
  if (body.address !== undefined) {
    await requireLegacyAddressNetwork(wallet.community_id, body.address);
    const scriptCbor = body.scriptCbor !== undefined
      ? body.scriptCbor
      : body.address === wallet.address ? wallet.script_cbor : null;
    Object.assign(patch, { address: body.address, ...resolveLegacyWalletScriptFields(body.address, scriptCbor) });
  } else if (body.scriptCbor !== undefined) {
    Object.assign(patch, resolveLegacyWalletScriptFields(wallet.address, body.scriptCbor));
  }
  if (Object.keys(patch).length === 0) throw new BadRequestError("Nothing to update");
  await updateLegacyWallet(wallet.id, patch);
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
