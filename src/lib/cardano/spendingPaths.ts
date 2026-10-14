// Spending paths: which branch of a treasury's script a transaction is built
// for, who signs on it, and when it is offered. The one home for the rule the
// build, sign, submit and reject routes and the signing page all apply.
// Client-safe.

import { MSG, SignerGroup, SpendingPath, TreasuryTemplate, TxKind } from "@/lib/constants";
import type { TreasurySignerRow, TreasuryRow } from "@/lib/db/types";
import { formatDate } from "@/lib/format";
import { describeThreshold } from "./thresholds";
import type { ScriptType } from "./types";

export type PathTreasury = Pick<
  TreasuryRow,
  "template" | "script_type" | "required" | "recovery_script_type" | "recovery_required" | "lock_until" | "cosigner_kind"
>;
export type PathSigner = Pick<TreasurySignerRow, "wallet_address" | "signer_group">;

/** Who must sign on a path: a flat rule over `members`, plus every `alsoRequired` wallet. */
export interface SigningRule {
  scriptType: ScriptType;
  required: number;
  /** Wallet addresses of the group. */
  members: string[];
  /** Wallet addresses that must sign as well (the co-signer). */
  alsoRequired: string[];
}

export function pathsOfTemplate(template: TreasuryTemplate): SpendingPath[] {
  switch (template) {
    case TreasuryTemplate.Clawback:
      return [SpendingPath.Base, SpendingPath.Recovery];
    case TreasuryTemplate.Cosigner:
      return [SpendingPath.Cosigned, SpendingPath.Bypass];
    default:
      return [SpendingPath.Base];
  }
}

/** The path a build takes when the request names none. */
export function defaultPath(template: TreasuryTemplate): SpendingPath {
  return template === TreasuryTemplate.Cosigner ? SpendingPath.Cosigned : SpendingPath.Base;
}

function wallets(signers: readonly PathSigner[], group: SignerGroup): string[] {
  return signers.filter((s) => s.signer_group === group).map((s) => s.wallet_address);
}

/** The signing rule of a path on this treasury. */
export function pathRule(treasury: PathTreasury, signers: readonly PathSigner[], path: SpendingPath): SigningRule {
  const base = wallets(signers, SignerGroup.Base);
  switch (path) {
    case SpendingPath.Recovery:
      return {
        scriptType: treasury.recovery_script_type ?? "any",
        required: treasury.recovery_required ?? 1,
        members: wallets(signers, SignerGroup.Recovery),
        alsoRequired: [],
      };
    case SpendingPath.Cosigned:
      return {
        scriptType: treasury.script_type,
        required: treasury.required,
        members: base,
        alsoRequired: wallets(signers, SignerGroup.Cosigner),
      };
    case SpendingPath.Bypass:
      return { scriptType: "all", required: base.length, members: base, alsoRequired: [] };
    default:
      return { scriptType: treasury.script_type, required: treasury.required, members: base, alsoRequired: [] };
  }
}

/** How many signers each group has, for `describeTemplate` ("2 of 3"). */
export function signerCounts(signers: readonly Pick<PathSigner, "signer_group">[]): Partial<Record<SignerGroup, number>> {
  const counts: Partial<Record<SignerGroup, number>> = {};
  for (const s of signers) counts[s.signer_group] = (counts[s.signer_group] ?? 0) + 1;
  return counts;
}

/** Every wallet whose signature counts on the path. */
export function pathParticipants(rule: SigningRule): string[] {
  return [...new Set([...rule.members, ...rule.alsoRequired])];
}

/** Whether the lock date (if any) has passed. */
export function lockOpen(treasury: Pick<PathTreasury, "lock_until">, nowMs: number): boolean {
  return !treasury.lock_until || Date.parse(treasury.lock_until) <= nowMs;
}

/** Whether a build on this path may start now, or why not. */
export function pathOffered(
  treasury: PathTreasury,
  path: SpendingPath,
  kind: TxKind,
  nowMs: number,
): { ok: true } | { ok: false; reason: string } {
  if (!pathsOfTemplate(treasury.template).includes(path)) return { ok: false, reason: MSG.pathNotOffered };
  const lockDate = treasury.lock_until ? formatDate(treasury.lock_until, "datetime") : "";
  if (path === SpendingPath.Base && treasury.template === TreasuryTemplate.LockUntil && !lockOpen(treasury, nowMs)) {
    return { ok: false, reason: `${MSG.lockedUntil} ${lockDate}` };
  }
  if (path === SpendingPath.Recovery) {
    if (!lockOpen(treasury, nowMs)) return { ok: false, reason: `${MSG.recoveryNotOpen} ${lockDate}` };
    if (kind !== TxKind.Payment) return { ok: false, reason: MSG.recoveryPaymentsOnly };
  }
  return { ok: true };
}

export function pathLabel(path: SpendingPath): string {
  switch (path) {
    case SpendingPath.Recovery:
      return "Recovery signers";
    case SpendingPath.Cosigned:
      return "Co-signed";
    case SpendingPath.Bypass:
      return "Bypass (every base signer)";
    default:
      return "Base signers";
  }
}

export function templateLabel(template: TreasuryTemplate): string {
  switch (template) {
    case TreasuryTemplate.Clawback:
      return "Clawback";
    case TreasuryTemplate.LockUntil:
      return "Lock-until";
    case TreasuryTemplate.Cosigner:
      return "Co-signer";
    default:
      return "Plain multisig";
  }
}

/**
 * The treasury's rule in a few words: "2 of 3", "2 of 3 · recovery from
 * 1 Mar 2027", "2 of 3 · locked until …", "2 of 3 + co-signer". Pass the
 * signer count per group when known.
 */
export function describeTemplate(
  treasury: PathTreasury,
  counts?: Partial<Record<SignerGroup, number>>,
): string {
  const base = describeThreshold(treasury.script_type, treasury.required, counts?.base ?? null);
  const lockDate = treasury.lock_until ? formatDate(treasury.lock_until) : "";
  switch (treasury.template) {
    case TreasuryTemplate.Clawback:
      return `${base} · recovery from ${lockDate}`;
    case TreasuryTemplate.LockUntil:
      return `${base} · locked until ${lockDate}`;
    case TreasuryTemplate.Cosigner:
      return `${base} + co-signer`;
    default:
      return base;
  }
}
