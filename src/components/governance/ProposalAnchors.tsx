"use client";

// Where each of the proposal's steps stands on-chain (label 190002): anchored
// (with when, beside when voting opened, so a late anchor shows), in progress
// in a pending transaction, due, or not yet applicable. Treasury actors can
// build the due ones now. Once the frozen record exists, Verify checks the
// document and the anchors in the browser (VerifyRecord).
import Link from "next/link";
import { AnchorStep, ANCHOR_STEPS } from "@/lib/constants";
import type { Network } from "@/lib/config";
import type { ProposalAnchorWithTx, ProposalRow, TreasurySummary } from "@/lib/db/types";
import { formatDate } from "@/lib/format";
import { anchoredLate, anchorStatus, closedWithoutVoting, type AnchorStepState } from "@/lib/governance/anchors";
import { isFinalProposal } from "@/lib/governance/lifecycle";
import { routes } from "@/lib/routes";
import { useAnchorsDue, useTallyRecord } from "@/hooks/useProposals";
import { Card, ExplorerLink, SectionTitle } from "@/components/ui";
import { BuildAnchorButton } from "./BuildAnchorButton";
import { VerifyRecord } from "./VerifyRecord";

const STEP_LABELS: Record<AnchorStep, string> = {
  [AnchorStep.Proposed]: "Proposed",
  [AnchorStep.Opened]: "Voting opened",
  [AnchorStep.Closed]: "Closed",
};

const STEP_CARRIES: Record<AnchorStep, string> = {
  [AnchorStep.Proposed]: "content and rules fingerprints",
  [AnchorStep.Opened]: "the voter list's fingerprint",
  [AnchorStep.Closed]: "the result and the frozen record's hash",
};

export function ProposalAnchors({ slug, communityId, proposal, anchors, treasuries, isAdmin, network }: {
  slug: string;
  communityId: string;
  proposal: ProposalRow;
  anchors: ProposalAnchorWithTx[];
  treasuries: readonly TreasurySummary[] | null;
  isAdmin: boolean;
  network: Network;
}) {
  const status = anchorStatus(anchors);
  const dueList = useAnchorsDue(communityId);
  const dueSteps = new Set(dueList.data?.find((p) => p.proposalId === proposal.id)?.steps ?? []);
  const record = useTallyRecord(isFinalProposal(proposal.state) && proposal.voting_opened_at ? proposal.id : null);

  if (!proposal.anchored) {
    return (
      <Card>
        <SectionTitle>On-chain anchors</SectionTitle>
        <p className="text-sm text-zinc-400">Not anchored: this proposal was already closed when on-chain anchoring started.</p>
      </Card>
    );
  }
  const neverAnchored = closedWithoutVoting(proposal) && status.proposed.status === "none";
  return (
    <Card>
      <SectionTitle>On-chain anchors</SectionTitle>
      <p className="mb-3 text-sm text-zinc-400">
        Each step puts the proposal&apos;s fingerprints on the Cardano chain (metadata, no funds), so the decision can be checked
        without trusting Guild Vault. Anchors ride on the community&apos;s next payout or payment, or go alone.
      </p>
      {neverAnchored ? (
        <p className="text-sm text-zinc-500">Closed before any anchor was made: nothing goes on-chain for it.</p>
      ) : (
        <ul className="space-y-2 text-sm">
          {ANCHOR_STEPS.map((step) => (
            <li key={step} className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 rounded-xl bg-zinc-800/60 px-3 py-2">
              <span>
                <span className="font-medium">{STEP_LABELS[step]}</span>
                <span className="ml-2 text-xs text-zinc-500">{STEP_CARRIES[step]}</span>
              </span>
              <StepState step={step} state={status[step]} due={dueSteps.has(step)} proposal={proposal} slug={slug} network={network} />
            </li>
          ))}
        </ul>
      )}
      {dueSteps.size > 0 && treasuries && (
        <div className="mt-3">
          <BuildAnchorButton slug={slug} communityId={communityId} treasuries={treasuries} isAdmin={isAdmin} />
        </div>
      )}
      {record.data && (
        <VerifyRecord proposal={proposal} anchors={status} network={network} />
      )}
    </Card>
  );
}

function StepState({ step, state, due, proposal, slug, network }: {
  step: AnchorStep;
  state: AnchorStepState;
  due: boolean;
  proposal: ProposalRow;
  slug: string;
  network: Network;
}) {
  if (state.status === "anchored") {
    const late = step !== AnchorStep.Closed && anchoredLate(state, proposal.voting_opened_at);
    return (
      <span className="text-right text-xs">
        <span className="text-emerald-400">Anchored</span>
        {state.blockTime && <> {formatDate(state.blockTime, "datetime")}</>}
        {late && proposal.voting_opened_at && (
          <span className="text-amber-500"> · after voting opened ({formatDate(proposal.voting_opened_at, "datetime")})</span>
        )}
        {!late && step === AnchorStep.Opened && proposal.voting_opened_at && (
          <span className="text-zinc-500"> · voting opened {formatDate(proposal.voting_opened_at, "datetime")}</span>
        )}
        {state.txHash && (
          <> · <ExplorerLink network={network} target={{ txHash: state.txHash }}>explorer</ExplorerLink></>
        )}
        {state.txId && <> · <Link className="underline" href={routes.tx(slug, state.txId)}>transaction</Link></>}
      </span>
    );
  }
  if (state.status === "in_progress") {
    return (
      <span className="text-right text-xs text-blue-400">
        In a transaction awaiting signatures
        {state.txId && <> · <Link className="underline" href={routes.tx(slug, state.txId)}>open</Link></>}
      </span>
    );
  }
  if (due) return <span className="text-xs text-amber-500">Due</span>;
  return <span className="text-xs text-zinc-500">{notYetText(step, proposal)}</span>;
}

function notYetText(step: AnchorStep, proposal: ProposalRow): string {
  if (step === AnchorStep.Opened) return proposal.voting_opened_at ? "Not applicable" : "Once voting opens";
  if (step === AnchorStep.Closed) {
    if (!isFinalProposal(proposal.state)) return "Once the proposal is final";
    return "Once the record is frozen and published";
  }
  return "Not yet";
}
