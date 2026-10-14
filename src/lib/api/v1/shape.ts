// Pure shaping of agent API answers: what a model reads should be exact,
// self-explanatory and small. Client-safe, no I/O.

import { assigneeLabel, sortedAssignees } from "@/lib/assignees";
import { formatQuantity } from "@/lib/assets";
import { amountRowsFromTask } from "@/lib/boardTypes";
import { pathRule, type PathSigner, type PathTreasury } from "@/lib/cardano/spendingPaths";
import type { ScriptType } from "@/lib/cardano/types";
import { SignerGroup, SpendingPath, TreasuryTemplate } from "@/lib/constants";
import type { TaskAssignee } from "@/lib/db/types";

/** "2 of 3 signers", "all 3 signers", "any 1 of 3 signers". */
function groupWords(scriptType: ScriptType, required: number, signerCount: number, noun = "signer"): string {
  const signers = `${signerCount} ${noun}${signerCount === 1 ? "" : "s"}`;
  if (scriptType === "all") return `all ${signers}`;
  if (scriptType === "any") return `any 1 of ${signers}`;
  return `${required} of ${signers}`;
}

/**
 * The treasury's rule in words, template included: "2 of 3 signers",
 * "2 of 3 signers; from 2027-03-01T00:00:00.000Z also any 1 of 2 recovery
 * signers", "2 of 3 signers, locked until …", "2 of 3 signers plus the
 * co-signer, or all 3 signers together".
 */
export function signingRule(treasury: PathTreasury, signers: readonly PathSigner[]): string {
  const base = pathRule(treasury, signers, SpendingPath.Base);
  const baseWords = groupWords(base.scriptType, base.required, base.members.length);
  switch (treasury.template) {
    case TreasuryTemplate.Clawback: {
      const recovery = pathRule(treasury, signers, SpendingPath.Recovery);
      return `${baseWords}; from ${treasury.lock_until} also ${groupWords(recovery.scriptType, recovery.required, recovery.members.length, "recovery signer")}`;
    }
    case TreasuryTemplate.LockUntil:
      return `${baseWords}, locked until ${treasury.lock_until}`;
    case TreasuryTemplate.Cosigner: {
      const count = signers.filter((s) => s.signer_group === SignerGroup.Base).length;
      return `${baseWords} plus the co-signer, or all ${count} signers together`;
    }
    default:
      return baseWords;
  }
}

/** An on-chain integer in display units, exact and ungrouped ("1234.5"). */
export function displayQuantity(quantity: bigint | string, decimals: number): string {
  const value = typeof quantity === "bigint" ? quantity : BigInt(quantity);
  return value < 0n ? `-${formatQuantity(-value, decimals)}` : formatQuantity(value, decimals);
}

/** A task's reward per assignee, ticker -> display amount (legacy ADA-only tasks included). */
export function taskReward(task: {
  amounts: Record<string, string> | null;
  bounty_lovelace: number | null;
}): Record<string, string> {
  return Object.fromEntries(amountRowsFromTask(task).map((row) => [row.ticker, row.amount]));
}

export interface AssigneeSummary {
  name: string;
  wallet: string | null;
}

/** Assignees in stored order, named as the board names them. */
export function assigneeSummaries(rows: readonly TaskAssignee[] | null | undefined): AssigneeSummary[] {
  return sortedAssignees(rows).map((a) => ({ name: assigneeLabel(a), wallet: a.wallet_address }));
}

/** What a write preview tells the assistant to do next. */
export const CONFIRM_NEXT =
  "Nothing has been done yet. Show this preview to the user and call draft_confirm with draftToken only if they explicitly agree, before expiresAt.";

export interface MemberRef {
  wallet: string;
  handle: string | null;
  githubUsername: string | null;
}

/**
 * The members `query` names, from the most exact way of naming one: their
 * wallet, else their handle (any case), else their GitHub login (with or
 * without "@"). Empty when none matches; more than one means the name is
 * ambiguous and the user must say which.
 */
export function matchMembers<M extends MemberRef>(query: string, members: readonly M[]): M[] {
  const q = query.trim();
  if (!q) return [];
  const byWallet = members.filter((m) => m.wallet === q);
  if (byWallet.length > 0) return byWallet;
  const lower = q.toLowerCase();
  const byHandle = members.filter((m) => m.handle?.trim().toLowerCase() === lower);
  if (byHandle.length > 0) return byHandle;
  const login = lower.replace(/^@/, "");
  return members.filter((m) => m.githubUsername?.toLowerCase() === login);
}

/** "YYYY-MM" of a stored day-1 budget date, or null. */
export function budgetMonthOf(date: string | null): string | null {
  return date ? date.slice(0, 7) : null;
}
