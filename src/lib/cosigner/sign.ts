// The app as co-signer (phase 7b): once the base signers of a co-signed
// transaction are done, run the check, record the decision, and on a pass
// add the app key's witness through the same merge and `add_signature`
// path a wallet's signature takes. Runs after a signature lands (sign
// route), on request (the cosign route) and from the reconcile sweep.
import "server-only";

import { pathRule } from "@/lib/cardano/spendingPaths";
import { thresholdReached } from "@/lib/cardano/thresholds";
import { mergeSignerWitnesses } from "@/lib/cardano/txSignUtils";
import { asNetwork } from "@/lib/config";
import { CosignerKind, CosignTrigger, SignerGroup, SpendingPath, TxState } from "@/lib/constants";
import { maybe, serviceClient } from "@/lib/db/client";
import { insertCosignerDecision, listPendingAppCosignedTransactions, loadCosignerDecisions, loadCosignerKey } from "@/lib/db/cosigner";
import { addSignature } from "@/lib/db/transactions";
import { loadTreasuryWithSigners } from "@/lib/db/treasuries";
import type { TransactionRow } from "@/lib/db/types";
import { BadRequestError, ConflictError, errorMessage, InvariantError, NotFoundError } from "@/lib/errors";
import { runCosignerCheck, type CosignerCheck } from "./check";
import { cosignerAddress, decryptSeed, witnessSetHex } from "./keys";

export interface CosignResult {
  /** Whether the app's witness landed. */
  signed: boolean;
  check: CosignerCheck;
}

async function loadTx(txId: string): Promise<TransactionRow> {
  const tx = maybe<TransactionRow>(
    await serviceClient().from("transactions").select("*").eq("id", txId).maybeSingle(),
    "load transaction",
  );
  if (!tx) throw new NotFoundError("Transaction not found");
  return tx;
}

/**
 * Check and, on a pass, co-sign a pending co-signed transaction of an
 * app-held co-signer treasury whose base signers have signed. Refusals of
 * the check are recorded and returned; a transaction that is not ready
 * (wrong path or kind of co-signer, base rule not met, already co-signed,
 * not pending) throws.
 */
export async function cosignWithAppKey(txId: string, trigger: CosignTrigger): Promise<CosignResult> {
  let tx = await loadTx(txId);
  const { treasury, signers } = await loadTreasuryWithSigners(tx.treasury_id);
  if (treasury.cosigner_kind !== CosignerKind.App) throw new BadRequestError("This treasury's co-signer is a member, not Treasury Guild");
  if (tx.spending_path !== SpendingPath.Cosigned) throw new BadRequestError("Only a co-signed transaction takes the co-signer's signature");
  if (tx.state !== TxState.Pending) throw new ConflictError("Transaction is no longer pending");
  const cosigner = signers.find((s) => s.signer_group === SignerGroup.Cosigner);
  const key = await loadCosignerKey(treasury.id);
  if (!cosigner || !key || cosigner.key_hash !== key.key_hash) throw new InvariantError("The treasury's co-signer key is missing");
  if (tx.signed_addresses.includes(cosigner.wallet_address)) throw new ConflictError("Already co-signed");
  if (!thresholdReached(pathRule(treasury, signers, SpendingPath.Base), tx.signed_addresses)) {
    throw new BadRequestError("The base signers have not finished signing yet");
  }

  const check = await runCosignerCheck(tx, treasury);
  let signed = false;
  if (check.passed) {
    try {
      const seed = decryptSeed(key.encrypted_key);
      const address = cosignerAddress(key.key_hash, asNetwork(treasury.network));
      if (address !== cosigner.wallet_address) throw new InvariantError("The co-signer's address does not match its key");
      // One retry: a wallet's signature may land between our read and our write.
      for (let attempt = 0; attempt < 2 && !signed; attempt++) {
        if (attempt > 0) tx = await loadTx(txId);
        if (tx.state !== TxState.Pending || tx.signed_addresses.includes(address)) break;
        const { txHex, invalidVkeyPubKeysHex, addedKeyHashes } = mergeSignerWitnesses(tx.tx_cbor, witnessSetHex(seed, tx.tx_hash!));
        if (invalidVkeyPubKeysHex.length > 0 || !addedKeyHashes.includes(key.key_hash)) {
          throw new InvariantError("The co-signer's witness does not verify against the transaction");
        }
        signed = await addSignature({ txId, wallet: address, txCbor: txHex, expectedCount: tx.signed_addresses.length });
      }
    } catch (err) {
      // The check passed but the witness could not be added: recorded, so the
      // transaction page shows why the treasury waits. The failure itself is
      // what the caller gets, also when recording it fails.
      await insertCosignerDecision({
        transactionId: txId, trigger, passed: true, problems: [], signed: false, error: errorMessage(err),
      }).catch((recordErr) => console.error(`recording the signing failure of tx ${txId} failed`, recordErr));
      throw err;
    }
  }
  await insertCosignerDecision({ transactionId: txId, trigger, passed: check.passed, problems: check.problems, signed });
  return { signed, check };
}

export interface CosignSweepResult {
  signed: number;
  refused: number;
}

/** How long the sweep leaves a transaction alone after a signing failure. */
const SIGNING_RETRY_MS = 60 * 60 * 1000;

/**
 * The sweep's pass over pending co-signed transactions of app-held
 * co-signers: those whose base signers are done and whose latest decision
 * did not sign (a refusal is re-run, in case the budget or the citations
 * changed since; a crash between the signature and the co-signature is
 * repaired here). A signing failure is retried once an hour, not every run:
 * it usually waits for an operator (a missing key secret).
 */
export async function cosignReadyTransactions(): Promise<CosignSweepResult> {
  const result: CosignSweepResult = { signed: 0, refused: 0 };
  for (const tx of await listPendingAppCosignedTransactions()) {
    try {
      const { treasury, signers } = await loadTreasuryWithSigners(tx.treasury_id);
      const cosigner = signers.find((s) => s.signer_group === SignerGroup.Cosigner);
      if (!cosigner || tx.signed_addresses.includes(cosigner.wallet_address)) continue;
      if (!thresholdReached(pathRule(treasury, signers, SpendingPath.Base), tx.signed_addresses)) continue;
      const latest = (await loadCosignerDecisions(tx.id))[0];
      if (latest?.signed) continue;
      if (latest?.error && Date.now() - Date.parse(latest.decided_at) < SIGNING_RETRY_MS) continue;
      const outcome = await cosignWithAppKey(tx.id, CosignTrigger.Sweep);
      if (outcome.signed) result.signed += 1;
      else result.refused += 1;
    } catch (err) {
      console.error(`co-signing tx ${tx.id} in the sweep failed`, err);
    }
  }
  return result;
}
