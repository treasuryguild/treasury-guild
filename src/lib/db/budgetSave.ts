// What a budget save needs before save_budget_setup: the owner (a workgroup
// or a treasury) with the wallet that vouches for unregistered tokens, and
// the amounts with their labels and decimals resolved. Shared by the direct
// save (/api/budgets) and budget proposals, which store the resolved amounts
// and apply them when the proposal passes. Callers authorize.
import "server-only";

import { ADA_ASSET, LOVELACE, tokenFallbackLabel } from "@/lib/assets";
import { budgetTokenLabel } from "@/lib/budgets";
import type { BudgetAmount } from "@/lib/budgetSetups";
import { applyWalletTokenHint, assetNameFromUnit } from "@/lib/cardano/assetInfo";
import { fetchWalletAssets } from "@/lib/cardano/walletAssets";
import { asNetwork } from "@/lib/config";
import { PgCode } from "@/lib/constants";
import { BadRequestError, NotFoundError } from "@/lib/errors";
import { loadAssetRegistry, loadMintAssetHints } from "./assets";
import { maybe, optionalRelation, rpc, serviceClient } from "./client";
import { loadTreasury } from "./treasuries";

/** Where the budget lives and which wallet vouches for an unregistered token. */
export interface BudgetOwnerContext {
  communityId: string;
  name: string;
  workgroupId: string | null;
  treasuryId: string | null;
  wallet: { address: string; network: number } | null;
  /** Shown when a token is neither in the registry nor held by the owner's wallet. */
  notHeldMessage: string;
}

export async function loadWorkgroupBudgetOwner(workgroupId: string): Promise<BudgetOwnerContext> {
  const workgroup = maybe<{
    community_id: string;
    name: string;
    treasury_id: string | null;
    treasuries: { address: string; network: number } | { address: string; network: number }[] | null;
  }>(
    await serviceClient()
      .from("workgroups")
      .select("community_id, name, treasury_id, treasuries(address, network)")
      .eq("id", workgroupId)
      .maybeSingle(),
    "load budget workgroup",
  );
  if (!workgroup) throw new NotFoundError("Workgroup not found");
  const treasury = optionalRelation(workgroup.treasuries);
  return {
    communityId: workgroup.community_id,
    name: workgroup.name,
    workgroupId,
    treasuryId: null,
    wallet: workgroup.treasury_id && treasury ? treasury : null,
    notHeldMessage: "Every selected token must currently be held by the project's treasury wallet",
  };
}

/** A treasury's budget covers manual payments made from it; its own wallet vouches for tokens. */
export async function loadTreasuryBudgetOwner(treasuryId: string): Promise<BudgetOwnerContext> {
  const treasury = await loadTreasury(treasuryId);
  return {
    communityId: treasury.community_id,
    name: treasury.name,
    workgroupId: null,
    treasuryId,
    wallet: { address: treasury.address, network: treasury.network },
    notHeldMessage: "Every selected token must currently be held by this treasury",
  };
}

/** A stored budget amount, as save_budget_setup keeps it. */
export type BudgetAmountRow = BudgetAmount & {
  workgroup_id: string | null;
  cadence: string;
  created_by: string;
  updated_at: string;
};

/**
 * Label and scale each amount: ADA as is, a token from its mint hint, the
 * owner's wallet or the registry. A token outside the registry must be held
 * by the owner's wallet.
 */
export async function resolveBudgetAmounts(
  owner: BudgetOwnerContext,
  budgets: readonly { unit: string; cadence: string; amount: string }[],
  actor: string,
): Promise<BudgetAmountRow[]> {
  const registry = await loadAssetRegistry(owner.communityId);
  const registryByUnit = new Map(registry.map((asset) => [asset.unit, asset]));
  const tokenUnits = budgets.filter((budget) => budget.unit !== LOVELACE).map((budget) => budget.unit);
  const mintHints = await loadMintAssetHints(tokenUnits);
  const unknownUnits = tokenUnits.filter((unit) => !registryByUnit.has(unit));
  let walletTokens = new Map<string, Awaited<ReturnType<typeof fetchWalletAssets>>["tokens"][number]>();

  if (unknownUnits.length > 0) {
    if (!owner.wallet) {
      throw new BadRequestError(owner.treasuryId
        ? owner.notHeldMessage
        : "Assign a treasury wallet to this project before using an unregistered token");
    }
    const walletAssets = await fetchWalletAssets(asNetwork(owner.wallet.network), owner.wallet.address);
    walletTokens = new Map(walletAssets.tokens.map((token) => [token.unit, token]));
    if (unknownUnits.some((unit) => !walletTokens.has(unit))) throw new BadRequestError(owner.notHeldMessage);
  }

  const updatedAt = new Date().toISOString();
  return budgets.map((budget) => {
    const base = {
      workgroup_id: owner.workgroupId,
      cadence: budget.cadence,
      unit: budget.unit,
      amount: budget.amount,
      created_by: actor,
      updated_at: updatedAt,
    };
    if (budget.unit === LOVELACE) {
      return { ...base, asset_label: ADA_ASSET.fieldName, decimals: ADA_ASSET.decimals };
    }
    const known = registryByUnit.get(budget.unit);
    const hint = mintHints.get(budget.unit);
    const walletToken = walletTokens.get(budget.unit);
    const resolvedToken = walletToken ? applyWalletTokenHint(walletToken, hint) : null;
    const assetLabel =
      hint?.ticker?.trim() ||
      (resolvedToken ? budgetTokenLabel(resolvedToken) : null) ||
      known?.fieldName ||
      assetNameFromUnit(budget.unit) ||
      tokenFallbackLabel(budget.unit);
    const decimals = hint?.decimals ?? resolvedToken?.decimals ?? known?.decimals ?? 0;
    return { ...base, asset_label: assetLabel, decimals };
  });
}

/**
 * Save an owner's budget setup (save_budget_setup) and return its new
 * revision. With budget consent on the RPC refuses (guard_budget_consent):
 * budgets then change through /api/proposals.
 */
export async function saveBudgetSetup(input: {
  workgroupId: string | null;
  treasuryId: string | null;
  expectedRevision: number;
  mode: string;
  cadence: string;
  startsOn: string;
  amounts: BudgetAmountRow[];
  actor: string;
  confirm: boolean | undefined;
  reason: string | undefined;
}): Promise<number> {
  return rpc<number>(
    await serviceClient().rpc("save_budget_setup", {
      p_workgroup_id: input.workgroupId, p_treasury_id: input.treasuryId,
      p_expected_revision: input.expectedRevision,
      p_mode: input.mode, p_cadence: input.cadence, p_starts_on: input.startsOn,
      p_amounts: input.amounts, p_actor: input.actor, p_confirm: input.confirm, p_reason: input.reason,
    }),
    // A check violation here is an invalid setup, not a state conflict.
    { [PgCode.CheckViolation]: BadRequestError },
  );
}
