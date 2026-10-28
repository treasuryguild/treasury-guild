"use client";

// How a proposal is (or would be) decided: method, who votes, timing and
// visibility, in a few lines. `electorate` is the snapshot size once voting
// opened, else an estimate.
import { describeElectorate, describeHours, describeMethod, METHOD_HELP } from "@/lib/governance/labels";
import type { ProposalRules } from "@/lib/governance/rules";

export function ProposalRulesSummary({ rules, electorate, estimate = false }: {
  rules: ProposalRules;
  electorate?: number | null;
  estimate?: boolean;
}) {
  const size = electorate === null || electorate === undefined
    ? ""
    : ` · ${estimate ? "about " : ""}${electorate} ${electorate === 1 ? "voter" : "voters"}`;
  return (
    <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
      <dt className="text-zinc-500">Decided by</dt>
      <dd>
        {describeMethod(rules)}
        <span className="block text-xs text-zinc-500">{METHOD_HELP[rules.method]}</span>
      </dd>
      <dt className="text-zinc-500">Who votes</dt>
      <dd>{describeElectorate(rules)}{size}{rules.recuseBeneficiaries ? " · those who gain from it are recused" : ""}</dd>
      <dt className="text-zinc-500">Discussion, then voting</dt>
      <dd>{describeHours(rules.discussionHours)}, then {describeHours(rules.votingHours)}</dd>
      <dt className="text-zinc-500">Results</dt>
      <dd>{rules.hideResults ? "Hidden until voting closes (turnout shows; then members see every ballot)" : "Shown while voting runs"}</dd>
    </dl>
  );
}
