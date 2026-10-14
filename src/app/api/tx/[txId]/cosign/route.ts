// Ask the app-held co-signer to run its check again on a pending co-signed
// transaction (after a refusal, once the budget or the citations changed),
// signing when it passes. Treasury actors only; the decision is recorded
// either way.
import { sessionRoute } from "@/lib/api/route";
import type { CosignResponse } from "@/lib/api/types";
import { memberRole, requireTreasuryActor } from "@/lib/authz";
import { CosignerKind, CosignTrigger, SignerGroup } from "@/lib/constants";
import { cosignWithAppKey } from "@/lib/cosigner/sign";
import { loadPendingTransactions } from "@/lib/db/transactions";
import { BadRequestError } from "@/lib/errors";
import { loadTxContext } from "@/lib/tx";

export const POST = sessionRoute<{ txId: string }>(async (_req, { params, session }) => {
  const { tx, treasury, callerSigner } = await loadTxContext(params.txId, session.wallet);
  const role = await memberRole(treasury.community_id, session.wallet);
  requireTreasuryActor(role ?? "", callerSigner?.signer_group === SignerGroup.Base, "Only community admins or treasury signers can ask the co-signer to check again");
  if (treasury.cosigner_kind !== CosignerKind.App) {
    throw new BadRequestError("This treasury's co-signer is a member: they sign on this page like any signer");
  }
  const { signed, check } = await cosignWithAppKey(tx.id, CosignTrigger.Manual);
  const [after] = await loadPendingTransactions([treasury.id]);
  return {
    signed,
    passed: check.passed,
    problems: check.problems,
    signedAddresses: after?.id === tx.id ? after.signed_addresses : tx.signed_addresses,
  } satisfies CosignResponse;
});
