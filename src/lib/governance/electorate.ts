// Who could cast a ballot on a proposal made now. The electorate is
// proposal_electorate; recusal drops beneficiaries when the rules say so.
// Client-safe: the create forms show the same reason prepareProposal throws.

/** Electorate size after recusal. Beneficiaries count unless `recuse` is set. */
export function eligibleVoterCount(
  wallets: readonly string[],
  beneficiaries: readonly string[],
  recuse: boolean,
): number {
  if (!recuse || beneficiaries.length === 0) return wallets.length;
  const recused = new Set(beneficiaries);
  let eligible = 0;
  for (const wallet of wallets) if (!recused.has(wallet)) eligible += 1;
  return eligible;
}

const EMPTY =
  "Nobody can vote on this proposal, so it would be cancelled as soon as voting opened. Change who votes or how long a member must have belonged, or add people to that group first.";
const RECUSED =
  "Everyone who could vote gains from this proposal and would be recused, so it would be cancelled as soon as voting opened. Turn recusal off, or include someone who does not gain from it.";

/**
 * Why this proposal must not be made, or null when someone could vote.
 * `count` is the electorate before recusal; `eligible` is after it.
 */
export function noEligibleVotersReason(count: number, eligible: number): string | null {
  if (eligible > 0) return null;
  return count > 0 ? RECUSED : EMPTY;
}
