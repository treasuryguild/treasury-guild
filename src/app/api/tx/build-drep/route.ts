// Builds a DRep register / update / retire transaction for a plain SDK treasury.
import { parseJson, sessionRoute } from "@/lib/api/route";
import { buildDrepSchema } from "@/lib/api/schemas";
import type { BuildDrepResponse } from "@/lib/api/types";
import { buildDrepAnchorJson, buildDrepTx, pinDrepAnchor } from "@/lib/cardano/drepBuilder";
import { fetchDrepStatus } from "@/lib/cardano/koios";
import { getProvider } from "@/lib/cardano/provider";
import { requireSdkDrep } from "@/lib/cardano/sdkTreasury";
import { DrepAction, SpendingPath, TxKind } from "@/lib/constants";
import { assertNoPendingTx, withTransactionRow } from "@/lib/db/transactions";
import { assertTreasuryActive } from "@/lib/db/treasuries";
import { BadRequestError, errorMessage } from "@/lib/errors";
import { drepDescription } from "@/lib/txDescription";
import { loadBuildContext, requirePathBuilder, resolveSpendingPath } from "@/lib/tx";

export const POST = sessionRoute(async (req, { session }) => {
  const body = await parseJson(req, buildDrepSchema);
  const { treasuryId, action } = body;
  const ctx = await loadBuildContext(treasuryId, session.wallet);
  assertTreasuryActive(ctx.treasury);
  const path = resolveSpendingPath(ctx, body.path, TxKind.Drep);
  if (path !== SpendingPath.Base) {
    throw new BadRequestError("DRep actions use the base spending path only");
  }
  requirePathBuilder(ctx, path, "Only treasury signers can build a DRep transaction");
  await assertNoPendingTx(treasuryId);

  const sdk = requireSdkDrep(ctx.treasury, ctx.signers);
  const status = await fetchDrepStatus(ctx.network, sdk.dRepId);

  if (action === DrepAction.Register && status.active) {
    throw new BadRequestError("This DRep is already registered");
  }
  if ((action === DrepAction.Update || action === DrepAction.Retire) && !status.active) {
    throw new BadRequestError("This DRep is not registered yet");
  }

  let anchor: { anchorUrl: string; anchorDataHash: string } | null = null;
  if (action === DrepAction.Register || action === DrepAction.Update) {
    try {
      const doc = buildDrepAnchorJson(body);
      anchor = await pinDrepAnchor(doc);
    } catch (err) {
      throw new BadRequestError(errorMessage(err));
    }
  }

  let built;
  try {
    built = await buildDrepTx({
      treasuryAddress: sdk.address,
      paymentScriptCbor: sdk.paymentScriptCbor,
      drepScriptCbor: sdk.drepScriptCbor,
      dRepId: sdk.dRepId,
      network: ctx.network,
      provider: getProvider(ctx.network),
      action,
      anchor,
    });
  } catch (err) {
    throw new BadRequestError(errorMessage(err));
  }

  const txRow = await withTransactionRow(
    {
      treasury_id: treasuryId,
      kind: TxKind.Drep,
      spending_path: path,
      tx_cbor: built.unsignedTxHex,
      tx_hash: built.txHash,
      description: drepDescription(action, sdk.dRepId),
      created_by: session.wallet,
      governance_action: {
        kind: "drep",
        action,
        dRepId: sdk.dRepId,
        anchorUrl: anchor?.anchorUrl ?? null,
      },
    },
    async (tx) => tx,
  );

  return {
    txId: txRow.id,
    txHash: built.txHash,
    action,
    dRepId: sdk.dRepId,
    anchorUrl: anchor?.anchorUrl ?? null,
  } satisfies BuildDrepResponse;
});
