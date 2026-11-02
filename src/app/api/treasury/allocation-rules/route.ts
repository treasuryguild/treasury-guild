// List and create Payday allocation rules for a paying treasury.
import { parseJson, sessionRoute } from "@/lib/api/route";
import { createAllocationRuleSchema } from "@/lib/api/schemas";
import type { AllocationRuleCreatedResponse, AllocationRulesListResponse } from "@/lib/api/types";
import { requireMember, requireTreasuryAdmin } from "@/lib/authz";
import { createAllocationRule, listAllocationRules } from "@/lib/db/allocationRules";
import { loadSiblingTreasuries } from "@/lib/db/payments";
import { loadTreasury } from "@/lib/db/treasuries";
import { BadRequestError } from "@/lib/errors";
import { addressToNetwork } from "@/lib/cardano/multisigSDK";
import { asNetwork, networkName } from "@/lib/config";

export const GET = sessionRoute(async (req, { session }) => {
  const treasuryId = new URL(req.url).searchParams.get("treasuryId");
  if (!treasuryId) throw new BadRequestError("treasuryId is required");
  const treasury = await loadTreasury(treasuryId);
  await requireMember(treasury.community_id, session.wallet);
  const rules = await listAllocationRules(treasuryId);
  return { rules } satisfies AllocationRulesListResponse;
});

export const POST = sessionRoute(async (req, { session }) => {
  const body = await parseJson(req, createAllocationRuleSchema);
  const treasury = await requireTreasuryAdmin(body.treasuryId, session.wallet);

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

  const rule = await createAllocationRule({
    community_id: treasury.community_id,
    treasury_id: treasury.id,
    label: body.label.trim(),
    basis_points: body.basisPoints,
    enabled: body.enabled,
    unit_scope: body.unitScope,
    recipient_wallet: body.recipientWallet ?? null,
    recipient_treasury_id: body.recipientTreasuryId ?? null,
    sort_order: body.sortOrder,
    units: body.unitScope === "selected" ? body.units : [],
    created_by: session.wallet,
  });
  return { id: rule.id } satisfies AllocationRuleCreatedResponse;
});
