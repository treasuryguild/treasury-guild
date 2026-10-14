// Typed display names -> community wallets. Zoom guests and pasted participant
// lists carry only a name, so a match is a suggestion a manager reviews on the
// call page before finalizing, never a verified identity.

import type { MemberOption } from "@/lib/boardTypes";

/** Comparison key: case, accents, a leading "@", punctuation and spacing ignored. */
export function normalizeName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    // Meeting apps append "(Host)", "(me)", "(Guest)" to the name.
    .replace(/\((?:host|co-host|me|guest|you)[^)]*\)/g, " ")
    .replace(/^\s*@/, "")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** A pasted list -> display names: one per line, blanks and repeats dropped. */
export function parsePastedNames(text: string): string[] {
  const seen = new Set<string>();
  const names: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    const name = line.trim().replace(/\s+/g, " ");
    const key = normalizeName(name);
    if (!key || seen.has(key)) continue;
    seen.add(key);
    names.push(name);
  }
  return names;
}

export interface NameMatchContext {
  /** Remembered matches (call_name_aliases): normalized name -> wallet. */
  aliases: ReadonlyMap<string, string>;
  members: readonly MemberOption[];
}

/**
 * The wallet for a typed name, or null. A remembered alias wins; otherwise
 * the name must equal exactly one member's handle or GitHub username. Two
 * members matching the same name is a tie nobody should guess at.
 */
export function matchName(name: string, ctx: NameMatchContext): string | null {
  const key = normalizeName(name);
  if (!key) return null;
  const alias = ctx.aliases.get(key);
  if (alias) return alias;
  const wallets = new Set<string>();
  for (const m of ctx.members) {
    const names = [m.handle, m.githubUsername].filter((n): n is string => !!n);
    if (names.some((n) => normalizeName(n) === key)) wallets.add(m.wallet);
  }
  const [only] = wallets;
  return wallets.size === 1 && only ? only : null;
}
