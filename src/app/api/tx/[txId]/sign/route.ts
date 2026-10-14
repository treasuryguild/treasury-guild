import { parseJson, sessionRoute } from "@/lib/api/route";
import { signTxSchema } from "@/lib/api/schemas";
import type { SignTxResponse } from "@/lib/api/types";
import { pathRule } from "@/lib/cardano/spendingPaths";
import { thresholdReached } from "@/lib/cardano/thresholds";
import { mergeSignerWitnesses } from "@/lib/cardano/txSignUtils";
import { CosignerKind, CosignTrigger, SignerGroup, SpendingPath } from "@/lib/constants";
import { cosignWithAppKey } from "@/lib/cosigner/sign";
import { addSignature } from "@/lib/db/transactions";
import { BadRequestError, ConflictError } from "@/lib/errors";
import { loadPendingTxForSigner } from "@/lib/tx";

export const POST = sessionRoute<{ txId: string }>(
  async (req, { params, session }) => {
    const { txId } = params;
    const { signedPayloadHex } = await parseJson(req, signTxSchema);

    const { tx, treasury, signers, signer } = await loadPendingTxForSigner(txId, session.wallet);
    if (tx.signed_addresses.includes(session.wallet)) {
      throw new ConflictError("Already signed by this wallet");
    }

    const { txHex, invalidVkeyPubKeysHex, addedKeyHashes } =
      mergeSignerWitnesses(tx.tx_cbor, signedPayloadHex);
    if (invalidVkeyPubKeysHex.length > 0) {
      throw new BadRequestError(
        "Witness does not verify against the transaction body",
      );
    }
    // The caller must have actually contributed their own key's witness.
    if (!addedKeyHashes.includes(signer.key_hash.toLowerCase())) {
      throw new BadRequestError(
        "Signed payload does not contain your key's witness",
      );
    }

    // Optimistic concurrency: only lands if no other signature arrived since
    // this signer read the cbor. On conflict the client refetches + re-signs.
    const landed = await addSignature({
      txId, wallet: session.wallet, txCbor: txHex, expectedCount: tx.signed_addresses.length,
    });
    if (!landed) {
      throw new ConflictError(
        "Another signature landed first. Reload and sign the updated transaction.",
      );
    }
    let signedAddresses = [...tx.signed_addresses, session.wallet];

    // On a co-signed transaction of an app-held co-signer: once the base
    // signers are done, the app runs its check and adds its witness (or
    // records why not). Best effort: a failure never fails this signer.
    const appCosigner = signers.find((s) => s.signer_group === SignerGroup.Cosigner)?.wallet_address;
    if (
      tx.spending_path === SpendingPath.Cosigned &&
      treasury.cosigner_kind === CosignerKind.App &&
      appCosigner && !signedAddresses.includes(appCosigner) &&
      thresholdReached({ ...pathRule(treasury, signers, SpendingPath.Base) }, signedAddresses)
    ) {
      try {
        const result = await cosignWithAppKey(txId, CosignTrigger.Sign);
        if (result.signed) signedAddresses = [...signedAddresses, appCosigner];
      } catch (err) {
        console.error(`co-signing tx ${txId} after a signature failed`, err);
      }
    }

    return {
      signedCount: signedAddresses.length,
      signedAddresses,
    } satisfies SignTxResponse;
  },
);
