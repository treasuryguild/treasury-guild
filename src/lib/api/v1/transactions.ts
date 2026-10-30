// A community's transactions (payouts, payments, mints, anchors), newest
// first, with where each stands.
import "server-only";

import { z } from "zod";
import type { V1Transaction, V1TransactionDetailResponse, V1TransactionsResponse } from "@/lib/api/types";
import { unitDisplayFromRegistry, unitTicker } from "@/lib/assetRegistry";
import { ADA_ASSET } from "@/lib/assets";
import { parseAnchorMetadata } from "@/lib/cardano/anchorMetadata";
import { parsePayoutMeta } from "@/lib/cardano/metadata";
import { parsePaymentMeta } from "@/lib/cardano/paymentMetadata";
import { pathParticipants, pathRule } from "@/lib/cardano/spendingPaths";
import { describeRule, requiredSignatures, thresholdReached } from "@/lib/cardano/thresholds";
import { TxKind, TxState, txStateMeta } from "@/lib/constants";
import { loadAssetRegistry } from "@/lib/db/assets";
import { loadMemberLabels } from "@/lib/db/payments";
import { listTreasuryTransactions, type TransactionListItem } from "@/lib/db/transactions";
import { findCommunityTransaction, loadTransactionDetail } from "@/lib/db/txDetail";
import { listCommunityTreasuries } from "@/lib/db/treasuries";
import { BadRequestError, NotFoundError } from "@/lib/errors";
import { voterName } from "@/lib/governance/labels";
import { spendProblemText } from "@/lib/governance/spendCheck";
import { routes } from "@/lib/routes";
import { defineEndpoint } from "./endpoint";
import { displayQuantity } from "./shape";
import { appLink, communityInput, memberCommunity } from "./shared";

export const TRANSACTION_LIST_MAX = 200;

const STATES = {
  pending: TxState.Pending,
  submitted: TxState.Submitted,
  confirmed: TxState.Confirmed,
  rejected: TxState.Rejected,
  canceled: TxState.Canceled,
} as const;

function describeTransaction(slug: string, treasuryName: string, tx: TransactionListItem): V1Transaction {
  return {
    id: tx.id,
    treasury: treasuryName,
    kind: tx.kind,
    state: txStateMeta(tx.state).label.toLowerCase(),
    description: tx.description,
    spendingPath: tx.spending_path,
    txHash: tx.tx_hash,
    signatures: tx.signed_addresses.length,
    rejections: tx.rejected_addresses.length,
    createdAt: tx.created_at,
    submittedAt: tx.submitted_at,
    blockTime: tx.block_time,
    spendProblems: (tx.spend_problems ?? []).map(spendProblemText),
    url: appLink(routes.tx(slug, tx.id)),
  };
}

export const listTransactions = defineEndpoint({
  scope: "communities:read",
  input: z.object({
    community: communityInput,
    treasury: z.string().trim().min(1).max(200).optional()
      .describe("Only this treasury: its name (case-insensitive) or id"),
    kind: z.enum([TxKind.Payout, TxKind.Payment, TxKind.Mint, TxKind.Anchor]).optional()
      .describe("payout = task rewards, payment = a manual payment or transfer, mint = tokens minted, anchor = proposal records only"),
    state: z.enum(["pending", "submitted", "confirmed", "rejected", "canceled"]).optional()
      .describe("pending = waiting for signatures, submitted = sent to the chain, confirmed = on chain, canceled = signed build freed the slot while holding reservations"),
    limit: z.coerce.number().int().min(1).max(TRANSACTION_LIST_MAX).default(25)
      .describe("Newest transactions first, at most this many"),
  }),
  async run(caller, input): Promise<V1TransactionsResponse> {
    const { community } = await memberCommunity(caller, input.community);
    const treasuries = await listCommunityTreasuries(community.id);

    let selected = treasuries;
    if (input.treasury) {
      const wanted = input.treasury.toLowerCase();
      selected = treasuries.filter((t) => t.id === input.treasury || t.name.toLowerCase() === wanted);
      if (selected.length === 0) {
        throw new BadRequestError(
          `No treasury "${input.treasury}" in this community. Treasuries: ${treasuries.map((t) => t.name).join(", ") || "none"}`,
        );
      }
    }

    const { transactions, total } = await listTreasuryTransactions(selected.map((t) => t.id), {
      kind: input.kind,
      state: input.state === undefined ? undefined : STATES[input.state],
      limit: input.limit,
    });
    const names = new Map(treasuries.map((t) => [t.id, t.name]));

    return {
      community: { slug: community.slug, name: community.name },
      transactions: transactions.map((tx) => describeTransaction(community.slug, names.get(tx.treasury_id) ?? "", tx)),
      total,
      url: appLink(routes.treasury(community.slug)),
    };
  },
});

export const transactionDetail = defineEndpoint({
  scope: "communities:read",
  input: z.object({
    community: communityInput,
    tx: z.string().trim().min(1).max(100).describe("The transaction's id (as transaction_list returns it) or its on-chain hash"),
  }),
  async run(caller, input): Promise<V1TransactionDetailResponse> {
    const { community } = await memberCommunity(caller, input.community);
    const treasuries = await listCommunityTreasuries(community.id);
    const tx = await findCommunityTransaction(treasuries.map((t) => t.id), input.tx);
    if (!tx) throw new NotFoundError(`No transaction ${input.tx} in this community`);
    const treasury = treasuries.find((t) => t.id === tx.treasury_id)!;
    const [detail, registry] = await Promise.all([loadTransactionDetail(tx), loadAssetRegistry(community.id)]);
    const display = unitDisplayFromRegistry(registry);
    const amount = (unit: string, quantity: string) => ({
      token: unitTicker(unit, display),
      amount: displayQuantity(quantity, display.get(unit)?.decimals ?? 0),
    });

    // Who signs on its own path, by address, as the signing page counts.
    const rule = pathRule(treasury, treasury.treasury_signers, tx.spending_path);
    const signerName = new Map(treasury.treasury_signers.map((s) => [s.wallet_address, s.display_name]));
    const who = (wallet: string) => ({ name: signerName.get(wallet) ?? null, wallet });
    const participants = pathParticipants(rule);
    const labels = await loadMemberLabels(community.id, [
      ...detail.payouts.map((p) => p.wallet),
      ...detail.payments.filter((p) => !p.recipient_treasury_id).map((p) => p.recipient_wallet),
    ]);

    // The record as it is on chain, read from the transaction's own CBOR.
    const { decodeTxForDisplay } = await import("@/lib/cardano/cborMetadata");
    const decoded = decodeTxForDisplay(tx.tx_cbor);
    const anchors = parseAnchorMetadata(decoded.anchorMeta);

    return {
      community: { slug: community.slug, name: community.name },
      transaction: describeTransaction(community.slug, treasury.name, tx),
      signing: {
        rule: describeRule(rule),
        requiredSignatures: requiredSignatures(rule),
        signed: tx.signed_addresses.map(who),
        rejected: tx.rejected_addresses.map(who),
        stillToSign: tx.state === TxState.Pending
          ? participants.filter((w) => !tx.signed_addresses.includes(w) && !tx.rejected_addresses.includes(w)).map(who)
          : [],
        readyToSubmit: tx.state === TxState.Pending && thresholdReached(rule, tx.signed_addresses),
      },
      payouts: detail.payouts.map((p) => ({
        recipient: voterName(p.wallet, labels.get(p.wallet)),
        wallet: p.wallet,
        task: p.taskNumber,
        taskTitle: p.taskTitle,
        workgroup: p.workgroup,
        ...amount(p.unit, p.amount),
      })),
      payments: detail.payments.map((p) => ({
        recipient: p.label ?? voterName(p.recipient_wallet, labels.get(p.recipient_wallet)),
        wallet: p.recipient_wallet,
        transfer: p.recipient_treasury_id !== null,
        budgetMonth: p.budget_month ? p.budget_month.slice(0, 7) : null,
        ...amount(p.unit, p.amount),
      })),
      mints: detail.mints.map((m) => ({
        asset: m.asset_name,
        ticker: m.ticker,
        kind: m.asset_kind,
        quantity: displayQuantity(m.quantity, m.decimals),
        recipient: m.recipient,
        policyId: m.policy_id,
      })),
      fee: decoded.fee ? displayQuantity(decoded.fee, ADA_ASSET.decimals) : null,
      message: decoded.message,
      onChainRecord: {
        payout: parsePayoutMeta(decoded.payoutMeta),
        payment: parsePaymentMeta(decoded.payoutMeta),
        anchors: anchors ? anchors.a : null,
      },
      cosigner: detail.decisions.map((d) => ({
        at: d.decided_at, trigger: d.trigger, passed: d.passed, problems: d.problems, signed: d.signed, error: d.error,
      })),
    };
  },
});
