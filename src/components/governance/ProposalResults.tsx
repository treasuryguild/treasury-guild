"use client";

// Turnout while ballots are hidden; counts, the outcome and every signed
// ballot once they are visible.
import { Card, SectionTitle } from "@/components/ui";
import { DecisionMethod, METHOD_CHOICES, ProposalState } from "@/lib/constants";
import type { ProposalRow, ProposalVoteRow } from "@/lib/db/types";
import { formatDate } from "@/lib/format";
import { CHOICE_LABELS, voterName } from "@/lib/governance/labels";
import { ballotsVisible } from "@/lib/governance/lifecycle";
import { OUTCOME_TEXT, tallyProposal, turnoutPct, type OutcomeReason } from "@/lib/governance/tally";
import { STORE_LABELS } from "@/lib/storage/locator";
import { useTallyRecord } from "@/hooks/useProposals";

/** The frozen record's hash and where copies were published, once the proposal is final. */
function TallyRecordLine({ proposalId }: { proposalId: string }) {
  const record = useTallyRecord(proposalId);
  if (!record.data) return null;
  return (
    <p className="mt-2 break-all text-xs text-zinc-500">
      Record frozen {formatDate(record.data.frozenAt, "datetime")} · blake2b-256 <span className="font-mono">{record.data.hash}</span>
      {record.data.copies.map((copy) => (
        <span key={copy.store}>
          {" · "}
          <a className="underline" href={copy.url} target="_blank" rel="noreferrer">Copy on {STORE_LABELS[copy.store]}</a>
        </span>
      ))}
    </p>
  );
}

export function ProposalResults({ proposal, votes, names }: {
  proposal: ProposalRow;
  votes: ProposalVoteRow[];
  names: Map<string, string | null>;
}) {
  const electorate = proposal.electorate_size;
  if (electorate === null) {
    return (
      <Card>
        <SectionTitle>Results</SectionTitle>
        <p className="text-sm text-zinc-400">Voting has not opened yet.</p>
      </Card>
    );
  }

  const quorumBallots = proposal.rules.method === DecisionMethod.Lazy
    ? 0
    : Math.ceil((proposal.rules.quorumPct * electorate) / 100);
  const turnout = (
    <p className="text-sm text-zinc-400">
      {proposal.ballots_cast} of {electorate} voted ({turnoutPct(proposal.ballots_cast, electorate)}%)
      {quorumBallots > 0 && ` · quorum is ${quorumBallots} ${quorumBallots === 1 ? "ballot" : "ballots"}`}
    </p>
  );

  if (!ballotsVisible(proposal)) {
    return (
      <Card>
        <SectionTitle>Results</SectionTitle>
        {turnout}
        <p className="mt-2 text-sm text-zinc-500">Ballots stay hidden until voting closes, so nobody votes with the crowd.</p>
      </Card>
    );
  }

  // The recorded tally once closed; a live count while results show during voting.
  const tally = proposal.tally ?? tallyProposal(proposal.rules, electorate, votes.map((v) => v.choice));
  const closed = proposal.state !== ProposalState.Voting;
  return (
    <Card>
      <SectionTitle action={
        // Every signed ballot with the proposal and its rules, hashed: anyone can check the result.
        <a className="text-sm underline" href={`/api/proposals/${proposal.id}/tally`} download>Download the signed tally</a>
      }>Results</SectionTitle>
      {turnout}
      {closed && proposal.outcome_reason && (
        <p className="mt-2 text-sm font-medium">{OUTCOME_TEXT[proposal.outcome_reason as OutcomeReason] ?? proposal.outcome_reason}</p>
      )}
      {closed && <TallyRecordLine proposalId={proposal.id} />}
      <ul className="mt-4 space-y-2">
        {METHOD_CHOICES[proposal.rules.method].map((choice) => {
          const count = tally.counts[choice] ?? 0;
          const pct = tally.ballots ? Math.round((count * 100) / tally.ballots) : 0;
          return (
            <li key={choice}>
              <div className="flex justify-between text-sm"><span>{CHOICE_LABELS[choice]}</span><span>{count}</span></div>
              <div className="mt-1 h-2 rounded-full bg-zinc-800" aria-hidden>
                <div className="h-2 rounded-full bg-[var(--accent)]" style={{ width: `${pct}%` }} />
              </div>
            </li>
          );
        })}
      </ul>
      {votes.length > 0 && (
        <>
          <h3 className="mb-2 mt-6 text-sm font-medium">Signed ballots</h3>
          <ul className="space-y-2">
            {votes.map((vote) => (
              <li key={vote.voter} className="rounded-xl bg-zinc-800/60 px-3 py-2 text-sm">
                <div className="flex flex-wrap justify-between gap-2">
                  <span><strong>{voterName(vote.voter, names.get(vote.voter))}</strong>: {CHOICE_LABELS[vote.choice]}</span>
                  <span className="text-xs text-zinc-500">{formatDate(vote.signed_at, "datetime")}</span>
                </div>
                {vote.reason && <p className="mt-1 text-zinc-400">{vote.reason}</p>}
                <details className="mt-1 text-xs text-zinc-500">
                  <summary className="cursor-pointer">Signature</summary>
                  <pre className="mt-1 whitespace-pre-wrap break-all">{vote.signed_text}</pre>
                  <p className="mt-1 break-all font-mono">key: {vote.cose_key}</p>
                  <p className="mt-1 break-all font-mono">signature: {vote.cose_signature}</p>
                </details>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  );
}
