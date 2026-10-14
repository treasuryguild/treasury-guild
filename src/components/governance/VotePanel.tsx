"use client";

// Cast or change your vote: pick a choice, give a reason where one is
// needed, sign the ballot with your wallet. The last signed ballot counts.
import { useState } from "react";
import { BusyOverlay, Button, Card, ErrorText, Field, NoticeText, SectionTitle, Textarea, WarningText } from "@/components/ui";
import { MAX_VOTE_REASON, METHOD_CHOICES, REASONED_CHOICES, type VoteChoice } from "@/lib/constants";
import type { ProposalRow, ProposalVoteRow, ProposalVoterRow } from "@/lib/db/types";
import { formatDate } from "@/lib/format";
import { CHOICE_LABELS, describeElectorate } from "@/lib/governance/labels";
import { useBallot } from "@/hooks/useBallot";

export function VotePanel({ proposal, seat, myVote, onVoted }: {
  proposal: ProposalRow;
  /** The session wallet's seat in the electorate, if any. */
  seat: ProposalVoterRow | undefined;
  myVote: ProposalVoteRow | undefined;
  onVoted: () => void;
}) {
  const choices = METHOD_CHOICES[proposal.rules.method];
  const [choice, setChoice] = useState<VoteChoice | null>(myVote?.choice ?? null);
  const [reason, setReason] = useState(myVote?.reason ?? "");
  const [done, setDone] = useState(false);
  const ballot = useBallot(proposal.id);

  if (!seat) {
    return (
      <Card>
        <SectionTitle>Your vote</SectionTitle>
        <p className="text-sm text-zinc-400">
          You are not in this proposal&apos;s electorate: {describeElectorate(proposal.rules)}, counted when voting opened.
        </p>
      </Card>
    );
  }
  if (seat.recused) {
    return (
      <Card>
        <SectionTitle>Your vote</SectionTitle>
        <p className="text-sm text-zinc-400">You are recused from this proposal because it benefits you.</p>
      </Card>
    );
  }

  const needsReason = !!choice && REASONED_CHOICES.includes(choice);
  const ready = !!choice && (!needsReason || reason.trim() !== "") && !ballot.blockedReason;

  async function submit() {
    if (!choice) return;
    setDone(false);
    if (await ballot.vote(choice, reason)) {
      setDone(true);
      onVoted();
    }
  }

  return (
    <Card>
      <BusyOverlay open={ballot.busy} title="Check your wallet to sign" hint="Your wallet shows the ballot text you are signing." />
      <SectionTitle>Your vote</SectionTitle>
      {myVote && (
        <p className="mb-3 text-sm text-zinc-400">
          You voted <strong className="text-zinc-200">{CHOICE_LABELS[myVote.choice]}</strong> on {formatDate(myVote.signed_at, "datetime")}.
          You can change it until voting closes.
        </p>
      )}
      <div role="radiogroup" aria-label="Your choice" className="mb-4 flex flex-wrap gap-2">
        {choices.map((c) => (
          <button key={c} type="button" role="radio" aria-checked={choice === c}
            className={`app-button ${choice === c ? "app-button-primary" : "app-button-secondary"}`}
            onClick={() => setChoice(c)}>
            {CHOICE_LABELS[c]}
          </button>
        ))}
      </div>
      <Field label={needsReason ? "Reason (required)" : "Reason (optional)"}
        hint={needsReason ? "Say what would have to change for you to accept it." : "Shown with your vote once results are visible."}>
        <Textarea aria-label="Reason for your vote" value={reason} rows={2} maxLength={MAX_VOTE_REASON}
          onChange={(e) => setReason(e.target.value)} />
      </Field>
      <WarningText className="mt-3">{ballot.blockedReason}</WarningText>
      <ErrorText error={ballot.error} className="mt-3" />
      <NoticeText className="mt-3">{done ? "Your signed vote is recorded." : null}</NoticeText>
      <div className="mt-4 flex justify-end">
        <Button disabled={!ready} loading={ballot.busy} onClick={() => void submit()}>
          {myVote ? "Sign and change vote" : "Sign and vote"}
        </Button>
      </div>
    </Card>
  );
}
