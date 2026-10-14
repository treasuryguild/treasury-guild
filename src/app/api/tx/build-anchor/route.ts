// Builds a dedicated anchor transaction: metadata only (label 190002), no
// outputs, change back to the treasury, carrying every anchor due in the
// community that fits. For when no payout or payment is coming to carry
// them. Admins or signers of the treasury build; it is signed and submitted
// on the normal transaction page like any other. One pending transaction per
// treasury still applies.
import { parseJson, sessionRoute } from "@/lib/api/route";
import { buildAnchorSchema } from "@/lib/api/schemas";
import type { BuildAnchorResponse } from "@/lib/api/types";
import { buildAnchorTx } from "@/lib/cardano/anchorBuilder";
import { fitAnchorEntries } from "@/lib/cardano/anchorMetadata";
import { getProvider } from "@/lib/cardano/provider";
import { TxKind } from "@/lib/constants";
import { recordProposalAnchors } from "@/lib/db/anchors";
import { assertNoPendingTx, withTransactionRow } from "@/lib/db/transactions";
import { BadRequestError } from "@/lib/errors";
import { loadDueAnchors } from "@/lib/governance/anchorsDue";
import { resolveTreasuryScript } from "@/lib/treasury";
import { loadBuildContext, requirePathBuilder, resolveSpendingPath, validFromSlotFor } from "@/lib/tx";
import { anchorDescription } from "@/lib/txDescription";

export const POST = sessionRoute(async (req, { session }) => {
  const { treasuryId, path: requestedPath } = await parseJson(req, buildAnchorSchema);
  const ctx = await loadBuildContext(treasuryId, session.wallet);
  const path = resolveSpendingPath(ctx, requestedPath, TxKind.Anchor);
  requirePathBuilder(ctx, path, "Only community admins or treasury signers can build an anchor transaction");
  await assertNoPendingTx(treasuryId);

  const due = await loadDueAnchors(ctx.treasury.community_id);
  const fitted = fitAnchorEntries(ctx.communitySlug, due);
  if (!fitted) throw new BadRequestError("No anchors are due");
  const numbers = [...new Set(fitted.carried.map((a) => a.number))].sort((a, b) => a - b);

  const { scriptCbor } = resolveTreasuryScript(ctx.treasury, ctx.signers);
  const dateStr = new Date().toISOString().slice(0, 10);
  const built = await buildAnchorTx({
    treasuryAddress: ctx.treasury.address,
    scriptCbor,
    network: ctx.network,
    provider: getProvider(ctx.network),
    record: fitted.record,
    message: `Treasury Guild anchors: ${ctx.communitySlug} ${dateStr}, ${numbers.length} ${numbers.length === 1 ? "proposal" : "proposals"}`,
    validFromSlot: validFromSlotFor(ctx.treasury, path),
  });

  const txRow = await withTransactionRow(
    {
      treasury_id: treasuryId,
      kind: TxKind.Anchor,
      spending_path: path,
      tx_cbor: built.unsignedTxHex,
      tx_hash: built.txHash,
      description: anchorDescription(numbers),
      created_by: session.wallet,
    },
    async (tx) => {
      await recordProposalAnchors(tx.id, fitted.carried);
      return tx;
    },
  );

  return {
    txId: txRow.id, txHash: built.txHash, proposals: numbers, remaining: due.length - fitted.carried.length,
  } satisfies BuildAnchorResponse;
});
