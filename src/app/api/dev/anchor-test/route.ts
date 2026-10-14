// Developer tool: build one metadata-only transaction (label 190002, no
// outputs, change back to the treasury) as a pending `anchor` transaction,
// to be signed and submitted on preprod through the normal transaction page.
// This is the phase-0 check that the ledger and the poller accept the shape
// the proposal anchors will use. DEV_WALLETS only (devRoute); the caller
// must also be able to act for the treasury, like any build.
import { devRoute, parseJson } from "@/lib/api/route";
import { devAnchorTestSchema } from "@/lib/api/schemas";
import type { DevAnchorTestResponse, DevAnchorTreasuriesResponse } from "@/lib/api/types";
import { buildAnchorTx } from "@/lib/cardano/anchorBuilder";
import { buildAnchorTestMetadata } from "@/lib/cardano/anchorMetadata";
import { getProvider } from "@/lib/cardano/provider";
import { TxKind } from "@/lib/constants";
import { assertNoPendingTx, withTransactionRow } from "@/lib/db/transactions";
import { listTreasuriesForWallet } from "@/lib/db/treasuries";
import { resolveTreasuryScript } from "@/lib/treasury";
import { loadBuildContext, requirePathBuilder, resolveSpendingPath, validFromSlotFor } from "@/lib/tx";

export const GET = devRoute(async (_req, { session }) => {
  const treasuries = await listTreasuriesForWallet(session.wallet);
  return {
    treasuries: treasuries.map((t) => ({
      id: t.id,
      name: t.name,
      network: t.network,
      communityName: t.communities.name,
      slug: t.communities.slug,
    })),
  } satisfies DevAnchorTreasuriesResponse;
});

export const POST = devRoute(async (req, { session }) => {
  const { treasuryId, path: requestedPath } = await parseJson(req, devAnchorTestSchema);
  const ctx = await loadBuildContext(treasuryId, session.wallet);
  const path = resolveSpendingPath(ctx, requestedPath, TxKind.Anchor);
  requirePathBuilder(ctx, path, "Only community admins or treasury signers can build from this treasury");
  await assertNoPendingTx(treasuryId);

  const record = buildAnchorTestMetadata(ctx.communitySlug);
  const { scriptCbor } = resolveTreasuryScript(ctx.treasury, ctx.signers);
  const built = await buildAnchorTx({
    treasuryAddress: ctx.treasury.address,
    scriptCbor,
    network: ctx.network,
    provider: getProvider(ctx.network),
    record,
    message: `Treasury Guild anchor test: ${ctx.communitySlug}`,
    validFromSlot: validFromSlotFor(ctx.treasury, path),
  });

  const txRow = await withTransactionRow(
    {
      treasury_id: treasuryId,
      kind: TxKind.Anchor,
      spending_path: path,
      tx_cbor: built.unsignedTxHex,
      tx_hash: built.txHash,
      description: "Anchor test (metadata only)",
      created_by: session.wallet,
    },
    async (tx) => tx,
  );

  return { txId: txRow.id, txHash: built.txHash, slug: ctx.communitySlug, record } satisfies DevAnchorTestResponse;
});
