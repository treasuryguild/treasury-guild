// The one home for treasury script templates: the four fixed native-script
// shapes a treasury can have (docs/onchain-anchoring-estimate.md, phases 6
// and 7), how each is built from its key groups, and how a decoded script is
// recognised as one of them. Client-safe: pure functions, `NativeScript` as a
// type only.
//
//   plain       base
//   clawback    any[ base, all[ recovery, after(slot) ] ]
//   lock_until  all[ base, after(slot) ]
//   cosigner    any[ all[ base, sig(co-signer) ], all[ every base key ] ]
//
// `base` and `recovery` are flat all / any / atLeast groups over `sig` leaves.

import type { NativeScript } from "@meshsdk/core";
import { TreasuryTemplate } from "@/lib/constants";
import type { DecodedNativeScript, ScriptType } from "./types";

/** One flat group of keys and its rule, keys in script order. */
export interface KeyGroup {
  scriptType: ScriptType;
  /** Meaningful for `atLeast`; the key count for `all`, 1 for `any`. */
  required: number;
  keyHashes: string[];
}

/** A treasury script as its template and groups; the lock and co-signer exist only for the templates that use them. */
export interface TreasuryShape {
  template: TreasuryTemplate;
  base: KeyGroup;
  recovery: KeyGroup | null;
  lockSlot: number | null;
  cosignerKeyHash: string | null;
}

type Sig = { type: "sig"; keyHash: string };

const sig = (keyHash: string): Sig => ({ type: "sig", keyHash });

/** The flat script of one group. */
export function groupScript(group: KeyGroup): NativeScript {
  const scripts = group.keyHashes.map(sig);
  if (group.scriptType === "all") return { type: "all", scripts };
  if (group.scriptType === "any") return { type: "any", scripts };
  return { type: "atLeast", required: group.required, scripts };
}

/** Signatures the group needs: every key for `all`, one for `any`, else its threshold. */
export function groupRequired(group: KeyGroup): number {
  if (group.scriptType === "all") return group.keyHashes.length;
  if (group.scriptType === "any") return Math.min(1, group.keyHashes.length);
  return group.required;
}

/** The group with its keys in CIP-1854 order (new wallets; imports keep their order). */
export function sortedGroup(group: KeyGroup): KeyGroup {
  return { ...group, keyHashes: [...group.keyHashes].sort() };
}

/** The whole payment script of a shape. */
export function templateScript(shape: TreasuryShape): NativeScript {
  const base = groupScript(shape.base);
  switch (shape.template) {
    case TreasuryTemplate.Plain:
      return base;
    case TreasuryTemplate.LockUntil:
      return { type: "all", scripts: [base, { type: "after", slot: String(shape.lockSlot) }] };
    case TreasuryTemplate.Clawback:
      return {
        type: "any",
        scripts: [
          base,
          { type: "all", scripts: [groupScript(shape.recovery!), { type: "after", slot: String(shape.lockSlot) }] },
        ],
      };
    case TreasuryTemplate.Cosigner:
      return {
        type: "any",
        scripts: [
          { type: "all", scripts: [base, sig(shape.cosignerKeyHash!)] },
          { type: "all", scripts: shape.base.keyHashes.map(sig) },
        ],
      };
  }
}

/** Every `sig` key of the shape in script order: base, recovery, co-signer. */
export function shapeKeyHashes(shape: TreasuryShape): string[] {
  return [
    ...shape.base.keyHashes,
    ...(shape.recovery?.keyHashes ?? []),
    ...(shape.cosignerKeyHash ? [shape.cosignerKeyHash] : []),
  ];
}

/**
 * A co-signer adds nothing when the base rule already needs every base
 * signer: the co-signed and bypass paths would be the same.
 */
export function cosignerAllowed(base: KeyGroup): boolean {
  return groupRequired(base) < base.keyHashes.length;
}

/** A flat all / any / atLeast group of `sig` leaves, else null. */
function flatGroup(node: DecodedNativeScript): KeyGroup | null {
  if (node.type !== "all" && node.type !== "any" && node.type !== "atLeast") return null;
  const keyHashes: string[] = [];
  for (const child of node.scripts) {
    if (child.type !== "sig") return null;
    keyHashes.push(child.keyHash.toLowerCase());
  }
  const required = node.type === "all" ? keyHashes.length : node.type === "any" ? 1 : node.required;
  return { scriptType: node.type, required, keyHashes };
}

function afterSlot(node: DecodedNativeScript): number | null {
  if (node.type !== "timelockStart") return null;
  const slot = Number(node.slot);
  return Number.isSafeInteger(slot) && slot > 0 ? slot : null;
}

/**
 * Recognise a decoded script as one of the four shapes; null for anything
 * else (other nestings, `before` locks, a co-signer branch that is not
 * exactly the base keys). Group sanity (no duplicates, thresholds in range)
 * is `shapeProblem`'s job.
 */
export function shapeFromDecoded(node: DecodedNativeScript): TreasuryShape | null {
  const plain = flatGroup(node);
  if (plain) return { template: TreasuryTemplate.Plain, base: plain, recovery: null, lockSlot: null, cosignerKeyHash: null };

  if (node.type === "all" && node.scripts.length === 2) {
    const base = flatGroup(node.scripts[0]!);
    const lockSlot = afterSlot(node.scripts[1]!);
    if (base && lockSlot !== null) {
      return { template: TreasuryTemplate.LockUntil, base, recovery: null, lockSlot, cosignerKeyHash: null };
    }
    return null;
  }

  if (node.type !== "any" || node.scripts.length !== 2) return null;
  const [first, second] = node.scripts as [DecodedNativeScript, DecodedNativeScript];

  const clawbackBase = flatGroup(first);
  if (clawbackBase && second.type === "all" && second.scripts.length === 2) {
    const recovery = flatGroup(second.scripts[0]!);
    const lockSlot = afterSlot(second.scripts[1]!);
    if (recovery && lockSlot !== null) {
      return { template: TreasuryTemplate.Clawback, base: clawbackBase, recovery, lockSlot, cosignerKeyHash: null };
    }
    return null;
  }

  if (first.type === "all" && first.scripts.length === 2 && first.scripts[1]!.type === "sig") {
    const base = flatGroup(first.scripts[0]!);
    const cosignerKeyHash = first.scripts[1]!.keyHash.toLowerCase();
    const bypass = flatGroup(second);
    if (
      base && bypass && bypass.scriptType === "all" &&
      bypass.keyHashes.length === base.keyHashes.length &&
      bypass.keyHashes.every((key, i) => key === base.keyHashes[i])
    ) {
      return { template: TreasuryTemplate.Cosigner, base, recovery: null, lockSlot: null, cosignerKeyHash };
    }
  }
  return null;
}

/** Why a shape cannot be a treasury, or null when it can. */
export function shapeProblem(shape: TreasuryShape): string | null {
  const groups: [string, KeyGroup][] = [["base", shape.base]];
  if (shape.recovery) groups.push(["recovery", shape.recovery]);
  for (const [name, group] of groups) {
    if (group.keyHashes.length === 0) return `The ${name} group must contain at least one signer`;
    if (group.scriptType === "atLeast" && (group.required < 1 || group.required > group.keyHashes.length)) {
      return `The ${name} group's required signatures must be between 1 and its number of signers`;
    }
  }
  const all = shapeKeyHashes(shape);
  if (new Set(all).size !== all.length) return "A key can appear in the script only once";
  if (shape.template === TreasuryTemplate.Cosigner && !cosignerAllowed(shape.base)) {
    return "Every base signer already has to sign, so a co-signer would add nothing";
  }
  return null;
}
