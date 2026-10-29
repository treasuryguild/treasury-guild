// Builds a CIP-0146 registration transaction: label-1854 metadata, no
// external outputs, change back to the treasury. Admins or base signers of
// the treasury build; it is signed and submitted on the normal transaction
// page. One pending transaction per treasury still applies. Recovery path
// is refused (pathOffered); lock-until waits until the lock opens.
import { parseJson, sessionRoute } from "@/lib/api/route";
import { buildRegistrationSchema } from "@/lib/api/schemas";
import type { BuildRegistrationResponse } from "@/lib/api/types";
import { getProvider } from "@/lib/cardano/provider";
import { buildRegistrationTx, registrationRecord } from "@/lib/cardano/registrationBuilder";
import { TxKind } from "@/lib/constants";
import { assertNoPendingTx, withTransactionRow } from "@/lib/db/transactions";
import { assertTreasuryActive } from "@/lib/db/treasuries";
import { resolveTreasuryScript } from "@/lib/treasury";
import { loadBuildContext, requirePathBuilder, resolveSpendingPath, validFromSlotFor } from "@/lib/tx";
import { registrationDescription } from "@/lib/txDescription";

export const POST = sessionRoute(async (req, { session }) => {
  const { treasuryId, path: requestedPath } = await parseJson(req, buildRegistrationSchema);
  const ctx = await loadBuildContext(treasuryId, session.wallet);
  assertTreasuryActive(ctx.treasury);
  const path = resolveSpendingPath(ctx, requestedPath, TxKind.Registration);
  requirePathBuilder(ctx, path, "Only treasury signers can build a registration transaction");
  await assertNoPendingTx(treasuryId);

  const { scriptCbor } = resolveTreasuryScript(ctx.treasury, ctx.signers);
  const record = registrationRecord(ctx.treasury, ctx.signers);
  const dateStr = new Date().toISOString().slice(0, 10);
  const built = await buildRegistrationTx({
    treasuryAddress: ctx.treasury.address,
    scriptCbor,
    network: ctx.network,
    provider: getProvider(ctx.network),
    record,
    message: `Treasury Guild registration: ${ctx.communitySlug} ${dateStr}`,
    validFromSlot: validFromSlotFor(ctx.treasury, path),
  });

  const txRow = await withTransactionRow(
    {
      treasury_id: treasuryId,
      kind: TxKind.Registration,
      spending_path: path,
      tx_cbor: built.unsignedTxHex,
      tx_hash: built.txHash,
      description: registrationDescription(),
      created_by: session.wallet,
    },
    async (tx) => tx,
  );

  return {
    txId: txRow.id,
    txHash: built.txHash,
  } satisfies BuildRegistrationResponse;
});
