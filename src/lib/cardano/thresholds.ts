// Pure multisig threshold predicates over a spending path's signing rule.
// Client-safe (the signing page shows progress with the same rules the
// submit and reject routes enforce). Signatures are wallet addresses, so a
// signature from outside the rule's group never counts.

import type { SigningRule } from "./spendingPaths";
import type { ScriptType } from "./types";

function groupReached(scriptType: ScriptType, required: number, total: number, count: number): boolean {
  if (scriptType === "any") return count >= 1;
  if (scriptType === "all") return count >= total;
  return count >= required;
}

/** Signatures a transaction on this path needs: the group's count plus every co-signer. */
export function requiredSignatures(rule: SigningRule): number {
  const group = rule.scriptType === "all"
    ? rule.members.length
    : rule.scriptType === "any"
      ? Math.min(1, rule.members.length)
      : rule.required;
  return group + rule.alsoRequired.length;
}

/** Whether enough signatures have landed to submit. */
export function thresholdReached(rule: SigningRule, signed: readonly string[]): boolean {
  const signedSet = new Set(signed);
  const count = rule.members.filter((m) => signedSet.has(m)).length;
  return (
    groupReached(rule.scriptType, rule.required, rule.members.length, count) &&
    rule.alsoRequired.every((w) => signedSet.has(w))
  );
}

/** Whether the threshold can still be reached given rejections. */
export function thresholdStillReachable(
  rule: SigningRule,
  signed: readonly string[],
  rejected: readonly string[],
): boolean {
  const signedSet = new Set(signed);
  const rejectedSet = new Set(rejected);
  if (rule.alsoRequired.some((w) => rejectedSet.has(w))) return false;
  const count = rule.members.filter((m) => signedSet.has(m)).length;
  const rejectedCount = rule.members.filter((m) => rejectedSet.has(m)).length;
  const remaining = rule.members.length - count - rejectedCount;
  if (rule.scriptType === "any") return count >= 1 || remaining >= 1;
  if (rule.scriptType === "all") return rejectedCount === 0;
  return count + remaining >= rule.required;
}

/**
 * "2 of 3", "all 3 signers" or "any signer" — for UI. Pass null for the
 * signer count when it is unknown ("2 of N").
 */
export function describeThreshold(
  scriptType: ScriptType,
  required: number,
  totalSigners: number | null,
): string {
  const n = totalSigners ?? "N";
  if (scriptType === "any") return "any signer";
  if (scriptType === "all") return `all ${n} signers`;
  return `${required} of ${n}`;
}

/** The rule of a path in words: "2 of 3", "2 of 3 + co-signer". */
export function describeRule(rule: SigningRule): string {
  const group = describeThreshold(rule.scriptType, rule.required, rule.members.length);
  return rule.alsoRequired.length > 0 ? `${group} + co-signer` : group;
}
