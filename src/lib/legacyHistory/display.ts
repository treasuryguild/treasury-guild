// How imported history names its recipients and its previous wallets.
import { contributorLabel } from "@/lib/assignees";
import { formatDate, formatUnits } from "@/lib/format";

export interface KnownWallet {
  wallet: string;
  handle: string | null;
  githubUsername: string | null;
}

/**
 * A recipient is stored as the end of their address: named after the one
 * known wallet ending with it, else shown as "…f39ntm". Two wallets sharing
 * the ending would make any name a guess.
 */
export function recipientLabel(ref: string, known: readonly KnownWallet[]): string {
  const match = knownWalletFor(ref, known);
  if (match) return contributorLabel(match);
  return ref.startsWith("addr") ? `…${ref.slice(-6)}` : `…${ref}`;
}

/** The one known wallet ending with `ref`, or null when none or several do. */
export function knownWalletFor(ref: string, known: readonly KnownWallet[]): KnownWallet | null {
  const matches = known.filter((k) => k.wallet.toLowerCase().endsWith(ref));
  const [only] = matches;
  return only && matches.length === 1 ? only : null;
}

/**
 * Who a history line paid, as the contributors chart counts people: the
 * member's wallet when the address end names exactly one (so they count once
 * with their payouts here), else the address end itself.
 */
export function legacyContributorKey(ref: string, known: readonly KnownWallet[]): string {
  const match = knownWalletFor(ref, known);
  if (match) return match.wallet;
  return ref.startsWith("addr") ? ref : `legacy:${ref}`;
}

/**
 * The task a history line belongs to: a task paid to several people is one
 * line each, sharing its workgroup, date and task text.
 */
export function legacyTaskKey(row: { workgroupId: string; paidOn: string; task: string }): string {
  return `legacy:${row.workgroupId}|${row.paidOn}|${row.task.replace(/\s+/g, " ").trim().toLowerCase()}`;
}

/** The spend source a previous wallet appears as on the Dashboard. */
export function legacyWalletLabel(name: string): string {
  return `${name} (previous wallet)`;
}

/** A "YYYY-MM-DD" day in the viewer's locale (read as local midnight, so it never shifts a day). */
export function formatDay(day: string): string {
  return formatDate(new Date(`${day}T00:00:00`));
}

/** Base-unit amounts as "480 AGIX, 80 ADA". */
export function formatAmounts(amounts: readonly { amount: string; decimals: number; ticker: string }[]): string {
  return amounts.map((a) => formatUnits(a.amount, a.decimals, a.ticker)).join(", ");
}
