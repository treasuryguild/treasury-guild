"use client";

// The proposal itself: who made it, where it stands, its text and the rules
// it is decided by, and (for a passed one) whether it was carried out.
import { Card, ErrorText, NoticeText } from "@/components/ui";
import { ExecutionState } from "@/lib/constants";
import type { ProposalRow } from "@/lib/db/types";
import { formatDate } from "@/lib/format";
import { KIND_LABELS, proposalTiming, voterName } from "@/lib/governance/labels";
import { ProposalRulesSummary } from "./ProposalRulesSummary";

export function ProposalOverview({ proposal, names, now }: {
  proposal: ProposalRow;
  names: Map<string, string | null>;
  now: number;
}) {
  return (
    <Card className="space-y-4">
      <p className="text-sm text-zinc-400">
        {KIND_LABELS[proposal.kind]} · proposed by {voterName(proposal.proposer, names.get(proposal.proposer))} on{" "}
        {formatDate(proposal.created_at)} · {proposalTiming(proposal, now)}
      </p>
      {proposal.body && <p className="whitespace-pre-wrap text-sm">{proposal.body}</p>}
      {proposal.discussion_url && (
        <p className="text-sm">
          Discussion:{" "}
          <a className="break-all underline" href={proposal.discussion_url} target="_blank" rel="noopener noreferrer nofollow">
            {proposal.discussion_url}
          </a>
        </p>
      )}
      {proposal.end_reason && <p className="text-sm text-zinc-400">Ended: {proposal.end_reason}</p>}
      <ExecutionLine proposal={proposal} />
      <div className="rounded-xl bg-zinc-800/60 p-3">
        <ProposalRulesSummary rules={proposal.rules} electorate={proposal.electorate_size} />
        <p className="mt-2 text-xs text-zinc-500">Chosen when the proposal was made. They stay fixed through discussion and voting.</p>
      </div>
      <details className="text-xs text-zinc-500">
        <summary className="cursor-pointer">Fingerprints every ballot signs</summary>
        <p className="mt-1 break-all font-mono">content: {proposal.content_hash}</p>
        <p className="mt-1 break-all font-mono">rules: {proposal.rules_hash}</p>
      </details>
    </Card>
  );
}

function ExecutionLine({ proposal }: { proposal: ProposalRow }) {
  switch (proposal.execution_state) {
    case ExecutionState.Pending:
      return <p className="text-sm text-zinc-400">Passed: being applied.</p>;
    case ExecutionState.Applied:
      return <NoticeText>Applied{proposal.executed_at ? ` on ${formatDate(proposal.executed_at, "datetime")}` : ""}.</NoticeText>;
    case ExecutionState.Failed:
      return <ErrorText error={`Passed, but could not be applied: ${proposal.execution_error ?? "unknown error"}`} />;
    default:
      return null;
  }
}
