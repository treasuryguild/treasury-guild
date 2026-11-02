// Update or delete one Payday allocation rule.
import { parseJson, sessionRoute } from "@/lib/api/route";
import { patchAllocationRuleSchema } from "@/lib/api/schemas";
import type { OkResponse } from "@/lib/api/types";
import { requireTreasuryAdmin } from "@/lib/authz";
import { addressToNetwork } from "@/lib/cardano/multisigSDK";
import { asNetwork, networkName } from "@/lib/config";
import {
  deleteAllocationRule,
  loadAllocationRule,
  updateAllocationRule,
} from "@/lib/db/allocationRules";
import { loadSiblingTreasuries } from "@/lib/db/payments";
import { BadRequestError, NotFoundError } from "@/lib/errors";

export const PATCH = sessionRoute<{ id: string }>(async (req, { params, session }) => {
  const body = await parseJson(req, patchAllocationRuleSchema);
  const existing = await loadAllocationRule(params.id);
  if (!existing) throw new NotFoundError("Allocation rule not found");
  const treasury = await requireTreasuryAdmin(existing.treasury_id, session.wallet);

  if (body.recipientTreasuryId) {
    const siblings = await loadSiblingTreasuries(treasury.community_id, treasury.id);
    const sib = siblings.find((s) => s.id === body.recipientTreasuryId);
    if (!sib || sib.archived_at) {
      throw new BadRequestError("Choose an active sibling treasury of this community");
    }
  }
  if (body.recipientWallet) {
    if (body.recipientWallet === treasury.address) {
      throw new BadRequestError("Cannot allocate to the paying treasury");
    }
    if (addressToNetwork(body.recipientWallet) !== asNetwork(treasury.network)) {
      throw new BadRequestError(`Use a ${networkName(asNetwork(treasury.network))} address`);
    }
  }

  await updateAllocationRule(existing.id, {
    label: body.label.trim(),
    basis_points: body.basisPoints,
    enabled: body.enabled,
    unit_scope: body.unitScope,
    recipient_wallet: body.recipientWallet,
    recipient_treasury_id: body.recipientTreasuryId,
    sort_order: body.sortOrder,
    units: body.unitScope === "selected" ? body.units : [],
  });
  return { ok: true } satisfies OkResponse;
});

export const DELETE = sessionRoute<{ id: string }>(async (_req, { params, session }) => {
  const existing = await loadAllocationRule(params.id);
  if (!existing) throw new NotFoundError("Allocation rule not found");
  await requireTreasuryAdmin(existing.treasury_id, session.wallet);
  await deleteAllocationRule(existing.id);
  return { ok: true } satisfies OkResponse;
});
