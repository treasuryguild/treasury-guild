// Treasury domain helpers: validate the stored script against the treasury
// row (template, rules, lock) and its grouped signer rows, and assert it
// still derives the stored address, preserving imported key order.
import "server-only";

import { resolveNativeScriptHash, type NativeScript } from "@meshsdk/core";
import type { TreasuryDetails, TreasuryNativeScriptView } from "./api/types";
import { MultisigWallet, type MultisigKey } from "./cardano/multisigSDK";
import { canDrep, canStake, isSdkTreasury } from "./cardano/sdkCapabilities";
import type { KeyGroup, TreasuryShape } from "./cardano/templates";
import { decodeTreasuryCbor } from "./cardano/treasuryImport";
import { asNetwork } from "./config";
import { SignerGroup } from "./constants";
import type { TreasuryRow, TreasurySignerRow } from "./db/types";
import { InvariantError } from "./errors";

function nativeScriptView(nativeScript: NativeScript, scriptCbor: string): TreasuryNativeScriptView {
  return {
    nativeScript,
    scriptCbor,
    scriptHash: resolveNativeScriptHash(nativeScript),
  };
}

/** Whether the rows carry exactly these keys, each once. */
function sameKeys(keyHashes: readonly string[], rows: readonly TreasurySignerRow[]): boolean {
  const keys = new Set(rows.map((r) => r.key_hash));
  return keys.size === rows.length && keyHashes.length === rows.length && keyHashes.every((k) => keys.has(k));
}

function sameRule(group: KeyGroup, scriptType: string | null, required: number | null): boolean {
  return group.scriptType === scriptType && (group.scriptType !== "atLeast" || group.required === required);
}

/** Why the stored row and signers disagree with the script, or null. */
function shapeMismatch(treasury: TreasuryRow, signers: TreasurySignerRow[], shape: TreasuryShape): string | null {
  const group = (g: SignerGroup) => signers.filter((s) => s.signer_group === g);
  if (shape.template !== treasury.template) return "template";
  if (!sameRule(shape.base, treasury.script_type, treasury.required)) return "base rule";
  if (!sameKeys(shape.base.keyHashes, group(SignerGroup.Base))) return "base signers";
  if (shape.recovery) {
    if (!sameRule(shape.recovery, treasury.recovery_script_type, treasury.recovery_required)) return "recovery rule";
    if (!sameKeys(shape.recovery.keyHashes, group(SignerGroup.Recovery))) return "recovery signers";
  } else if (group(SignerGroup.Recovery).length > 0 || treasury.recovery_script_type !== null) {
    return "recovery group";
  }
  if ((shape.lockSlot ?? null) !== (treasury.lock_slot === null ? null : Number(treasury.lock_slot))) return "lock slot";
  if (shape.cosignerKeyHash) {
    if (!treasury.cosigner_kind || !sameKeys([shape.cosignerKeyHash], group(SignerGroup.Cosigner))) return "co-signer";
  } else if (group(SignerGroup.Cosigner).length > 0 || treasury.cosigner_kind !== null) {
    return "co-signer";
  }
  return null;
}

export function buildTreasuryWallet(
  treasury: TreasuryRow,
  signers: TreasurySignerRow[],
): { wallet: MultisigWallet; shape: TreasuryShape } {
  const stored = decodeTreasuryCbor(treasury.script_cbor);
  const mismatch = shapeMismatch(treasury, signers, stored.shape);
  if (mismatch) {
    throw new InvariantError(`Treasury signing rule does not match its stored script (${mismatch})`);
  }
  // The wallet's own keys only matter for staking; the payment script is the
  // stored one, so every template goes through the same derivation.
  const keys: MultisigKey[] = [];
  for (const signer of signers) {
    if (signer.signer_group !== SignerGroup.Base) continue;
    keys.push({ keyHash: signer.key_hash, role: 0, name: signer.display_name ?? "" });
    if (signer.stake_key_hash) {
      keys.push({ keyHash: signer.stake_key_hash, role: 2, name: signer.display_name ?? "" });
    }
    if (signer.drep_key_hash) {
      keys.push({ keyHash: signer.drep_key_hash, role: 3, name: signer.display_name ?? "" });
    }
  }
  const wallet = new MultisigWallet(
    treasury.name,
    keys,
    "",
    treasury.required,
    asNetwork(treasury.network),
    treasury.stake_credential_hash ?? undefined,
    treasury.script_type,
    stored.paymentScript,
  );
  return { wallet, shape: stored.shape };
}

export interface ResolvedTreasury {
  wallet: MultisigWallet;
  address: string;
  /** Spending script CBOR (what tx inputs are witnessed with). */
  scriptCbor: string;
  /** The payment native script (also the base of a mint forge policy). */
  paymentScript: NativeScript;
  /** The template and its groups, as read from the script. */
  shape: TreasuryShape;
}

/**
 * The runtime-derived script for spending. Throws if the derived address no
 * longer matches the stored one (would produce unspendable/misdirected txs).
 */
export function resolveTreasury(
  treasury: TreasuryRow,
  signers: TreasurySignerRow[],
): ResolvedTreasury {
  const { wallet, shape } = buildTreasuryWallet(treasury, signers);
  const paymentScript = wallet.buildScript(0);
  if (!paymentScript) {
    throw new InvariantError("Treasury has no payment script");
  }
  const { address, scriptCbor } = wallet.getScript();
  if (!scriptCbor) {
    throw new InvariantError("Failed to derive treasury script");
  }
  if (address !== treasury.address) {
    throw new InvariantError(
      `Derived treasury address does not match stored address for treasury ${treasury.id}`,
    );
  }
  return { wallet, address, scriptCbor, paymentScript, shape };
}

/**
 * What the treasury details dialog shows. The script and signers are checked
 * via `resolveTreasury`, so a drifted address is refused here too; signers are
 * listed in native-script order (imports may use a different key order).
 */
export function describeTreasury(
  treasury: TreasuryRow,
  signers: TreasurySignerRow[],
): TreasuryDetails {
  const { wallet, address, scriptCbor, paymentScript, shape } = resolveTreasury(
    treasury,
    signers,
  );
  const keyOrder = decodeTreasuryCbor(scriptCbor).keyHashes;
  const ordered = [...signers].sort((a, b) => keyOrder.indexOf(a.key_hash) - keyOrder.indexOf(b.key_hash));
  const cosignerRow = signers.find((s) => s.signer_group === SignerGroup.Cosigner) ?? null;
  const sdk = isSdkTreasury(treasury, wallet);
  const stakeCapable = canStake(treasury, wallet);
  const drepCapable = canDrep(treasury, wallet);

  let stakeScript: TreasuryDetails["stakeScript"] = null;
  if (stakeCapable) {
    const stakeNative = wallet.buildScript(2);
    const stakeCbor = wallet.getStakingScript();
    if (stakeNative && stakeCbor) {
      stakeScript = nativeScriptView(stakeNative, stakeCbor);
    }
  }

  let drepScript: TreasuryDetails["drepScript"] = null;
  if (drepCapable) {
    const paymentFallback = !wallet.drepEnabled();
    const drepNative = paymentFallback ? paymentScript : wallet.buildScript(3);
    const drepCbor = wallet.getDRepScript();
    if (drepNative && drepCbor) {
      drepScript = { ...nativeScriptView(drepNative, drepCbor), paymentFallback };
    }
  }

  return {
    id: treasury.id,
    name: treasury.name,
    network: asNetwork(treasury.network),
    address,
    scriptType: treasury.script_type,
    required: treasury.required,
    template: treasury.template,
    lockSlot: treasury.lock_slot === null ? null : Number(treasury.lock_slot),
    lockUntil: treasury.lock_until,
    recovery: shape.recovery ? { scriptType: shape.recovery.scriptType, required: shape.recovery.required } : null,
    cosigner: cosignerRow && treasury.cosigner_kind
      ? { kind: treasury.cosigner_kind, keyHash: cosignerRow.key_hash, walletAddress: cosignerRow.wallet_address }
      : null,
    nativeScript: paymentScript,
    scriptCbor,
    scriptHash: resolveNativeScriptHash(paymentScript),
    stakeScript,
    drepScript,
    cip1854Metadata: sdk ? wallet.getJsonMetadata() : null,
    stakeCredentialHash: treasury.stake_credential_hash,
    stakeAddress: wallet.getStakeAddress() ?? null,
    dRepId: drepCapable ? wallet.getDRepId() ?? null : null,
    sdk,
    canStake: stakeCapable,
    canDrep: drepCapable,
    signers: ordered.map((s) => ({
      walletAddress: s.wallet_address,
      keyHash: s.key_hash,
      displayName: s.display_name,
      group: s.signer_group,
      stakeKeyHash: s.stake_key_hash,
      drepKeyHash: s.drep_key_hash,
    })),
  };
}

export function resolveTreasuryScript(
  treasury: TreasuryRow,
  signers: TreasurySignerRow[],
): { address: string; scriptCbor: string } {
  const { address, scriptCbor } = resolveTreasury(treasury, signers);
  return { address, scriptCbor };
}
