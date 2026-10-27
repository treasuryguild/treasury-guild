// Builds a manual payment from a treasury (Payments page): one multisig tx
// to any mix of outside addresses, community members and the community's
// other treasuries. Spend outputs are charged to the treasury's own budget
// for the chosen period; an output to a sibling treasury is a transfer and
// carries no budget month. Never writes community_assets.
import { parseJson, sessionRoute } from "@/lib/api/route";
import { buildPaymentSchema } from "@/lib/api/schemas";
import type { BuildPaymentResponse } from "@/lib/api/types";
import type { UnitDisplay } from "@/lib/assetRegistry";
import { ADA_ASSET, formatQuantity, LOVELACE } from "@/lib/assets";
import { budgetTokenLabel, currentBudgetMonth } from "@/lib/budgets";
import { budgetOwnerLabel, taskBudgetPeriod } from "@/lib/budgetSetups";
import { buildPaymentTx } from "@/lib/cardano/paymentBuilder";
import { getProvider } from "@/lib/cardano/provider";
import { fetchWalletAssets, type WalletAssets } from "@/lib/cardano/walletAssets";
import { TxKind } from "@/lib/constants";
import { recordProposalAnchors } from "@/lib/db/anchors";
import { loadBudgetSetupsForTreasury, loadBudgetSources } from "@/lib/db/budgetSetups";
import { loadAppliedBudgetProposal, loadProposalCitations } from "@/lib/db/governance";
import { insertPayments, loadMemberLabels, loadSiblingTreasuries } from "@/lib/db/payments";
import { assertNoPendingTx, withTransactionRow } from "@/lib/db/transactions";
import { BadRequestError } from "@/lib/errors";
import { loadDueAnchorsBestEffort } from "@/lib/governance/anchorsDue";
import { citationsOf } from "@/lib/governance/citations";
import { budgetOwnerKey } from "@/lib/governance/payload";
import { spendKey } from "@/lib/governance/spendCheck";
import { budgetsForLines, guardSpend, type SpendGuardLine } from "@/lib/governance/spendGuard";
import { resolvePaymentRecipients } from "@/lib/payments/recipients";
import { resolveTreasuryScript } from "@/lib/treasury";
import { builtTickers, builtTxResponse, loadBuildContext, requirePathBuilder, resolveSpendingPath, validFromSlotFor } from "@/lib/tx";
import { paymentDescription } from "@/lib/txDescription";

/** Display amounts for every unit the wallet holds (provisional ADA; the drain subtracts the fee). */
function walletDrainAmounts(wallet: WalletAssets): Record<string, string> {
  const amounts: Record<string, string> = {};
  if (wallet.lovelace > 0n) amounts[LOVELACE] = formatQuantity(wallet.lovelace, ADA_ASSET.decimals);
  for (const token of wallet.tokens) {
    if (token.quantity > 0n) {
      amounts[token.unit] = formatQuantity(token.quantity, token.decimals);
    }
  }
  return amounts;
}

export const POST = sessionRoute(async (req, { session }) => {
  const { wallet } = session;
  const {
    treasuryId, path: requestedPath, budgetMonth, memo, proposalId, drain, recipients: rawInputs,
  } = await parseJson(req, buildPaymentSchema);

  const ctx = await loadBuildContext(treasuryId, wallet);
  const { treasury, signers, network } = ctx;
  // The path decides who builds: base signers, or on a clawback treasury's
  // recovery path (from its lock date) recovery signers only.
  const path = resolveSpendingPath(ctx, requestedPath, TxKind.Payment);
  requirePathBuilder(ctx, path, "Only treasury signers can start a payment");
  await assertNoPendingTx(treasuryId);

  const ownerKey = budgetOwnerKey({ workgroupId: null, treasuryId });
  const [walletAssets, siblingTreasuries, members, setups, budgetSources, namedProposal] = await Promise.all([
    fetchWalletAssets(network, treasury.address),
    loadSiblingTreasuries(treasury.community_id, treasuryId),
    loadMemberLabels(treasury.community_id, rawInputs.map((r) => r.address)),
    loadBudgetSetupsForTreasury(treasuryId),
    loadBudgetSources([ownerKey]),
    proposalId ? loadAppliedBudgetProposal(treasury.community_id, proposalId) : null,
  ]);
  // A named proposal is checked server-side: a passed and applied budget
  // proposal of this community, or the build is refused.
  if (proposalId && !namedProposal) {
    throw new BadRequestError("The proposal to cite is not an applied budget proposal of this community");
  }

  // Tickers and decimals come from what the wallet holds, never from the client.
  const unitDisplay: UnitDisplay = new Map([
    [ADA_ASSET.unit, { ticker: ADA_ASSET.fieldName, decimals: ADA_ASSET.decimals }],
    ...walletAssets.tokens.map((token): [string, { ticker: string; decimals: number }] =>
      [token.unit, { ticker: budgetTokenLabel(token), decimals: token.decimals }]),
  ]);
  // A drain ignores client amounts and moves every held asset (ADA after fee).
  const inputs = drain
    ? (() => {
      const amounts = walletDrainAmounts(walletAssets);
      if (Object.keys(amounts).length === 0) {
        throw new BadRequestError("The paying treasury holds nothing to move");
      }
      return [{ address: rawInputs[0]!.address, amounts }];
    })()
    : rawInputs;
  const { recipients, problems } = resolvePaymentRecipients(inputs, {
    network,
    treasuryAddress: treasury.address,
    siblingTreasuries,
    members,
    tokens: unitDisplay,
  });
  if (problems.length > 0 || recipients.length === 0) {
    throw new BadRequestError("Some recipients cannot be paid", { problems });
  }

  // The period the spend counts against, read through the treasury's own
  // setup in force for that month: a quarterly treasury budget stores the
  // quarter's first month and writes "YYYY-Qn" on-chain, like a task would.
  const period = taskBudgetPeriod(`${budgetMonth}-01`, setups, currentBudgetMonth());
  const trimmedMemo = memo?.trim() || null;

  // Spend outputs count against the treasury's budget for the period and
  // cite the proposal that set it; transfers are not spends and cite only a
  // proposal named in the request (a "fund this budget" transfer).
  const lines: SpendGuardLine[] = recipients.filter((r) => r.treasuryId === null).flatMap((r) =>
    r.amounts.map((a) => ({
      ownerKey, ownerType: "treasury" as const, ownerId: treasuryId, ownerName: budgetOwnerLabel("treasury", treasury.name),
      periodMonth: period.month, unit: a.unit, amount: a.quantity,
      ticker: unitDisplay.get(a.unit)?.ticker ?? a.unit, decimals: unitDisplay.get(a.unit)?.decimals ?? 0,
    })));
  const budgetProposalId = lines.length > 0
    ? budgetsForLines(lines, budgetSources).get(spendKey(ownerKey, period.month))?.proposalId
    : null;
  const cited = await loadProposalCitations([budgetProposalId, namedProposal?.id].filter((id): id is string => !!id));
  const citations = citationsOf([budgetProposalId, namedProposal?.id], cited);
  const spendProblems = await guardSpend(treasury.community_id, lines, budgetSources);
  // Due proposal anchors ride along (label 190002); a failure to load them never blocks the payment.
  const anchors = await loadDueAnchorsBestEffort(treasury.community_id);

  const { scriptCbor } = resolveTreasuryScript(treasury, signers);
  const built = await buildPaymentTx({
    treasuryAddress: treasury.address,
    scriptCbor,
    communitySlug: ctx.communitySlug,
    network,
    provider: getProvider(network),
    recipients,
    budgetPeriod: period.code,
    memo: trimmedMemo,
    citations,
    unitDisplay,
    anchors,
    validFromSlot: validFromSlotFor(treasury, path),
    drain: !!drain,
  });
  const carried = built.anchorsCarried as typeof anchors;
  // Drain adjusts ADA for the fee; always persist the amounts the builder recorded.
  const paid = built.recipients;

  const tickers = builtTickers(built, unitDisplay);
  const transfers = paid.filter((r) => r.treasuryId !== null).length;
  const txRow = await withTransactionRow(
    {
      treasury_id: treasuryId,
      kind: TxKind.Payment,
      spending_path: path,
      tx_cbor: built.unsignedTxHex,
      tx_hash: built.txHash,
      description: paymentDescription({ memo: trimmedMemo, recipients: paid.length, transfers, tickers }),
      created_by: wallet,
      spend_problems: spendProblems,
    },
    async (tx) => {
      // One row per (recipient, unit); transfers carry no budget month.
      await insertPayments(paid.flatMap((r) =>
        r.amounts.map((a) => ({
          transaction_id: tx.id,
          community_id: treasury.community_id,
          treasury_id: treasuryId,
          recipient_wallet: r.address,
          recipient_treasury_id: r.treasuryId,
          label: r.label,
          unit: a.unit,
          amount: a.quantity.toString(),
          budget_month: r.treasuryId ? null : `${period.month}-01`,
        })),
      ));
      await recordProposalAnchors(tx.id, carried);
      return tx;
    },
  );

  return { ...builtTxResponse(txRow.id, built) } satisfies BuildPaymentResponse;
});
