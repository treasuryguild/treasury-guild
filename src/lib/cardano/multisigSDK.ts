/**
 * Multisig wallet core, lifted from the Mesh Multisig Platform's multisigSDK.
 *
 * Key invariants (per CIP-1854):
 * - New scripts sort keys lexicographically by keyHash so every participant
 *   derives identical bytes. Imported payment scripts preserve their key order.
 * - One MultisigWallet produces one native script per key role
 *   (0 = payment, 2 = stake, 3 = DRep).
 */

import {
  type NativeScript,
  resolveNativeScriptHash,
  resolvePaymentKeyHash,
  resolveScriptHashDRepId,
  resolveStakeKeyHash,
  serializeNativeScript,
  serializeRewardAddress,
} from "@meshsdk/core";
import { getDRepIds } from "@meshsdk/core-cst";
import type { ScriptType } from "./types";

export interface MultisigKey {
  /** The 28-byte Ed25519 key hash as a hex string (56 characters) */
  keyHash: string;
  /** The role of the key: 0=payment, 2=staking, 3=DRep */
  role: number;
  /** Human-readable name for the key */
  name: string;
}

export class MultisigWallet {
  name: string;
  description: string;
  /** Keys sorted lexicographically by keyHash (CIP-1854) */
  keys: MultisigKey[];
  required: number;
  /** 0 = preprod/testnet, 1 = mainnet */
  network: number;
  stakeCredentialHash: string | undefined;
  type: ScriptType;

  constructor(
    name: string,
    keys: MultisigKey[],
    description?: string,
    required?: number,
    network?: number,
    stakeCredentialHash?: string,
    type: ScriptType = "atLeast",
    private readonly paymentScript?: NativeScript,
  ) {
    this.name = name;
    const filteredKeys = keys.filter(
      (k) => k.keyHash && k.keyHash !== "undefined" && !isNaN(k.role),
    );
    this.keys = [...filteredKeys].sort((a, b) =>
      a.keyHash.localeCompare(b.keyHash),
    );
    this.description = description ?? "";
    this.required = required ?? 1;
    this.network = network !== undefined ? network : 1;
    this.stakeCredentialHash = stakeCredentialHash;
    this.type = type;
  }

  /** The wallet's script address + payment script CBOR. */
  getScript(): { address: string; scriptCbor: string | undefined } {
    const paymentScript = this.buildScript(0);
    if (!paymentScript) {
      throw new Error(
        "Cannot build multisig script: no valid payment keys provided.",
      );
    }
    return getScript(
      paymentScript,
      this.network,
      this.stakingEnabled()
        ? this.getStakeCredentialHash()
        : this.stakeCredentialHash,
    );
  }

  getPaymentScript(): string | undefined {
    const paymentScript = this.buildScript(0);
    if (!paymentScript) return undefined;
    return getScript(paymentScript, this.network).scriptCbor;
  }

  /** Role-2 stake native script CBOR, when staking keys are present. */
  getStakingScript(): string | undefined {
    const stakingScript = this.buildScript(2);
    if (!stakingScript) return undefined;
    return getScript(stakingScript, this.network).scriptCbor;
  }

  /**
   * DRep native script CBOR: role-3 when complete, else the payment script
   * (Multisig fallback). Callers that require an SDK treasury still gate on
   * stakingEnabled() before treating this as a DRep feature.
   */
  getDRepScript(): string | undefined {
    const dRepScript = this.drepEnabled() ? this.buildScript(3) : this.buildScript(0);
    if (!dRepScript) return undefined;
    return getScript(dRepScript, this.network).scriptCbor;
  }

  getKeysByRole(role: number): MultisigKey[] | undefined {
    const filteredKeys = this.keys.filter((key) => key.role === role);
    return filteredKeys.length === 0 ? undefined : filteredKeys;
  }

  buildScript(role: number): NativeScript | undefined {
    if (role === 0 && this.paymentScript) return this.paymentScript;
    const filteredKeys = this.getKeysByRole(role);
    if (!filteredKeys) return undefined;
    return buildNativeScript(filteredKeys, this.required, this.type);
  }

  /** Staking requires one stake key per payment key. */
  stakingEnabled(): boolean {
    const paymentKeyCount = this.getKeysByRole(0)?.length;
    const stakeKeyCount = this.getKeysByRole(2)?.length;
    if (!paymentKeyCount || !stakeKeyCount) return false;
    return paymentKeyCount === stakeKeyCount;
  }

  /** Dedicated DRep keys: one role-3 key per payment key. */
  drepEnabled(): boolean {
    const paymentKeyCount = this.getKeysByRole(0)?.length;
    const drepKeyCount = this.getKeysByRole(3)?.length;
    if (!paymentKeyCount || !drepKeyCount) return false;
    return paymentKeyCount === drepKeyCount;
  }

  getStakeCredentialHash(): string | undefined {
    if (this.stakeCredentialHash) return this.stakeCredentialHash;
    const stakeScript = this.buildScript(2);
    if (!stakeScript) return undefined;
    return resolveNativeScriptHash(stakeScript);
  }

  getStakeAddress(): string | undefined {
    const stakeCredentialHash = this.getStakeCredentialHash();
    if (!stakeCredentialHash) return undefined;
    return serializeRewardAddress(stakeCredentialHash, true, this.network ? 1 : 0);
  }

  /** CIP-105 DRep id from the DRep (or payment-fallback) script hash. */
  getDRepId105(): string | undefined {
    const script = this.drepEnabled() ? this.buildScript(3) : this.buildScript(0);
    if (!script) return undefined;
    return resolveScriptHashDRepId(resolveNativeScriptHash(script));
  }

  /** CIP-129 DRep id, or undefined when no script can be built. */
  getDRepId(): string | undefined {
    const cip105 = this.getDRepId105();
    if (!cip105) return undefined;
    return getDRepIds(cip105).cip129;
  }

  /** CIP-0146-shaped metadata describing the wallet's participants. */
  getJsonMetadata(): object {
    const types = Array.from(new Set(this.keys.map((key) => key.role)));
    const participants = this.keys.reduce(
      (acc, key) => {
        acc[key.keyHash] = { name: key.name || "" };
        return acc;
      },
      {} as Record<string, { name: string }>,
    );
    return {
      name: this.name,
      description: this.description,
      participants,
      types,
    };
  }
}

function buildNativeScript(
  keys: MultisigKey[],
  requiredSigners: number,
  type: ScriptType = "atLeast",
): NativeScript {
  const sortedKeys = [...keys].sort((a, b) => a.keyHash.localeCompare(b.keyHash));
  const sigScripts = sortedKeys.map(
    (key): { type: "sig"; keyHash: string } => ({
      type: "sig",
      keyHash: key.keyHash,
    }),
  );

  if (type === "all") return { type: "all", scripts: sigScripts };
  if (type === "any") return { type: "any", scripts: sigScripts };
  return { type: "atLeast", required: requiredSigners, scripts: sigScripts };
}

function getScript(
  script: NativeScript,
  network: number,
  stakeCredentialHash?: string,
): { address: string; scriptCbor: string } {
  const { address, scriptCbor } = serializeNativeScript(
    script,
    stakeCredentialHash,
    network,
    true,
  );
  if (!scriptCbor) {
    throw new Error("Failed to serialize multisig script");
  }
  return { address, scriptCbor };
}

export function paymentKeyHash(address: string): string {
  return resolvePaymentKeyHash(address);
}

// stakeKeyHash / checkValidStakeKey are vendored SDK surface, unused here.
export function stakeKeyHash(stakeAddress: string): string {
  return resolveStakeKeyHash(stakeAddress);
}

export function addressToNetwork(address: string): number {
  return address.includes("test") ? 0 : 1;
}

export function checkValidAddress(address: string): boolean {
  try {
    resolvePaymentKeyHash(address);
    return true;
  } catch {
    return false;
  }
}

export function checkValidStakeKey(stakeKey: string): boolean {
  try {
    resolveStakeKeyHash(stakeKey);
    return true;
  } catch {
    return false;
  }
}
