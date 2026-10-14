// The outcome of a proposal from its ballots: the one home for how each
// decision method counts. Integer math only. Client-safe (the page shows the
// stored tally; the server computes it when voting closes).
import { DecisionMethod, ProposalState, VoteChoice } from "@/lib/constants";
import type { ProposalRules } from "./rules";

/** Why a proposal ended as it did (proposals.outcome_reason). */
export type OutcomeReason =
  | "passed"
  /** Consent or majority with no ballots at all. */
  | "no_votes"
  | "quorum"
  | "blocked"
  /** Consent: not more agree than disagree. */
  | "support"
  /** Majority: yes did not exceed the threshold of yes + no. */
  | "threshold"
  | "objections";

export type TallyState = typeof ProposalState.Passed | typeof ProposalState.Rejected | typeof ProposalState.Expired;

/** proposals.tally */
export interface ProposalTally {
  counts: Partial<Record<VoteChoice, number>>;
  ballots: number;
  /** Voters who could vote (recused ones excluded). */
  electorate: number;
  quorumMet: boolean;
  state: TallyState;
  reason: OutcomeReason;
}

export const OUTCOME_TEXT: Record<OutcomeReason, string> = {
  passed: "Passed",
  no_votes: "Nobody voted",
  quorum: "Not enough members voted to reach the quorum",
  blocked: "A member blocked it",
  support: "Not more members agreed than disagreed",
  threshold: "Not enough yes votes",
  objections: "Enough members objected",
};

export function tallyProposal(
  rules: Pick<ProposalRules, "method" | "quorumPct" | "thresholdPct" | "lazyObjections">,
  electorate: number,
  choices: readonly string[],
): ProposalTally {
  const counts: Partial<Record<VoteChoice, number>> = {};
  for (const choice of choices) counts[choice as VoteChoice] = (counts[choice as VoteChoice] ?? 0) + 1;
  const n = (choice: VoteChoice) => counts[choice] ?? 0;
  const ballots = choices.length;
  const result = (state: TallyState, reason: OutcomeReason, quorumMet: boolean): ProposalTally =>
    ({ counts, ballots, electorate, quorumMet, state, reason });

  if (rules.method === DecisionMethod.Lazy) {
    return n(VoteChoice.Object) >= rules.lazyObjections
      ? result(ProposalState.Rejected, "objections", true)
      : result(ProposalState.Passed, "passed", true);
  }

  if (ballots === 0) return result(ProposalState.Expired, "no_votes", false);
  // ballots / electorate >= quorum%, without fractions.
  const quorumMet = ballots * 100 >= rules.quorumPct * electorate;
  if (!quorumMet) return result(ProposalState.Expired, "quorum", false);

  if (rules.method === DecisionMethod.Consent) {
    if (n(VoteChoice.Block) > 0) return result(ProposalState.Rejected, "blocked", true);
    return n(VoteChoice.Agree) > n(VoteChoice.Disagree)
      ? result(ProposalState.Passed, "passed", true)
      : result(ProposalState.Rejected, "support", true);
  }

  // Majority: strictly more than threshold% of yes + no (a 50/50 tie fails).
  const yes = n(VoteChoice.Yes);
  const decided = yes + n(VoteChoice.No);
  return decided > 0 && yes * 100 > rules.thresholdPct * decided
    ? result(ProposalState.Passed, "passed", true)
    : result(ProposalState.Rejected, "threshold", true);
}

/** Share of the electorate that voted, in whole percent (rounded down). */
export function turnoutPct(ballots: number, electorate: number | null): number {
  return electorate ? Math.floor((ballots * 100) / electorate) : 0;
}
