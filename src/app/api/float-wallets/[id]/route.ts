// Rename / note a float wallet, or archive / restore it.
import { parseJson, sessionRoute } from "@/lib/api/route";
import { floatWalletLifecycleSchema, patchFloatWalletSchema } from "@/lib/api/schemas";
import type { OkResponse } from "@/lib/api/types";
import { requireAdmin } from "@/lib/authz";
import {
  archiveFloatWallet,
  requireFloatWallet,
  restoreFloatWallet,
  updateFloatWallet,
} from "@/lib/db/floatWallets";
import { BadRequestError } from "@/lib/errors";

export const PATCH = sessionRoute<{ id: string }>(async (req, { params, session }) => {
  const body = await parseJson(req, patchFloatWalletSchema);
  const wallet = await requireFloatWallet(params.id);
  await requireAdmin(wallet.community_id, session.wallet);
  if (body.name === undefined && body.note === undefined) {
    throw new BadRequestError("Nothing to update");
  }
  await updateFloatWallet(wallet.id, {
    ...(body.name !== undefined && { name: body.name.trim() }),
    ...(body.note !== undefined && { note: body.note?.trim() || null }),
  });
  return { ok: true } satisfies OkResponse;
});

export const POST = sessionRoute<{ id: string }>(async (req, { params, session }) => {
  const { action } = await parseJson(req, floatWalletLifecycleSchema);
  const wallet = await requireFloatWallet(params.id);
  await requireAdmin(wallet.community_id, session.wallet);
  if (action === "archive") await archiveFloatWallet(wallet.id, session.wallet);
  else await restoreFloatWallet(wallet.id);
  return { ok: true } satisfies OkResponse;
});
