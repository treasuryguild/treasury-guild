"use client";

// One proposal: what it says and changes, your vote, the results, its history.
// When a deadline passes while the page is open it asks the server to take
// the due step (open voting, count, apply) instead of waiting for the sweep.
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useEffect, useMemo, useRef, useState } from "react";
import { EmptyState, ErrorText, PageTitle } from "@/components/ui";
import { BudgetProposalView } from "@/components/governance/BudgetProposalView";
import { NewProposalDialog, type DialogKind, type ProposerRoles } from "@/components/governance/NewProposalDialog";
import { ProposalActions } from "@/components/governance/ProposalActions";
import { ProposalAnchors } from "@/components/governance/ProposalAnchors";
import { ProposalOverview } from "@/components/governance/ProposalOverview";
import { ProposalResults } from "@/components/governance/ProposalResults";
import { ProposalStateBadge } from "@/components/governance/ProposalStateBadge";
import { ProposalTimeline } from "@/components/governance/ProposalTimeline";
import { ReviseBudgetDialog } from "@/components/governance/ReviseBudgetDialog";
import { TaskProposalView } from "@/components/governance/TaskProposalView";
import { WorkgroupProposalView } from "@/components/governance/WorkgroupProposalView";
import { VotePanel } from "@/components/governance/VotePanel";
import { apiFetch } from "@/lib/api/client";
import { asNetwork } from "@/lib/config";
import { ProposalKind } from "@/lib/constants";
import { dueAction, isVotingOpen } from "@/lib/governance/lifecycle";
import { isTaskPayload } from "@/lib/governance/payload";
import { routes } from "@/lib/routes";
import { useCommunityGate } from "@/hooks/useCommunityGate";
import { useCommunityMembers } from "@/hooks/useCommunityMembers";
import { useMyTreasuryRoles } from "@/hooks/useMyTreasuryRoles";
import { useNow } from "@/hooks/useNow";
import { useGovernanceSettings, useProposal } from "@/hooks/useProposals";
import { activeTreasuries, useTreasuries } from "@/hooks/useTreasuries";
import { useWorkgroups } from "@/hooks/useWorkgroups";
import { useWorkgroupTreasuryAssignments } from "@/hooks/useWorkgroupTreasuryAssignments";

export default function ProposalPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = use(params);
  const router = useRouter();
  const { community, isAdmin, sessionWallet, blocked } = useCommunityGate(slug);
  const details = useProposal(community ? id : null);
  const members = useCommunityMembers(community?.id);
  const workgroups = useWorkgroups(community?.id, true);
  const treasuries = useTreasuries(community?.id);
  const assignments = useWorkgroupTreasuryAssignments(isAdmin ? community?.id : null);
  const settings = useGovernanceSettings(community?.id);
  const roles = useMyTreasuryRoles(community?.id);
  const now = useNow(15_000);
  const nudged = useRef<string | null>(null);
  const [revising, setRevising] = useState(false);

  const proposal = details.data?.proposal;
  const due = proposal ? dueAction(proposal, now) : null;
  const { reload } = details;
  useEffect(() => {
    if (!due || !proposal) return;
    // Once per step: the server re-checks the clock and may say "not yet".
    const key = `${proposal.id}:${proposal.state}:${proposal.execution_state}:${due}`;
    if (nudged.current === key) return;
    nudged.current = key;
    void apiFetch(`/api/proposals/${proposal.id}/advance`, { method: "POST" }).catch(() => undefined).then(reload);
  }, [due, proposal, reload]);

  const names = useMemo(
    () => new Map((members.data ?? []).map((m) => [m.wallet_address, m.contributors?.handle ?? null])),
    [members.data],
  );
  const ownerNames = useMemo(() => new Map<string, string>([
    ...(workgroups.data ?? []).map((w): [string, string] => [w.id, w.name]),
    ...(treasuries.data ?? []).map((t): [string, string] => [t.id, t.name]),
  ]), [workgroups.data, treasuries.data]);

  const viewer: ProposerRoles = { isAdmin, ledWorkgroupIds: roles.ledWorkgroupIds };

  if (blocked) return blocked;
  if (details.data === null && !details.loading) {
    return <EmptyState>Proposal not found. <Link className="underline" href={routes.proposals(slug)}>All proposals</Link></EmptyState>;
  }
  if (!details.data || !proposal) return <ErrorText error={details.error} />;

  const { voters, votes, events, anchors, budgetOwners, replaces, revisedBy } = details.data;
  const seat = voters.find((v) => v.wallet_address === sessionWallet);
  const myVote = votes.find((v) => v.voter === sessionWallet);
  const dialogKind = proposal.kind === ProposalKind.Decision || proposal.kind === ProposalKind.Workgroup
    || proposal.kind === ProposalKind.Task
    ? proposal.kind as DialogKind
    : null;

  return (
    <div className="mx-auto max-w-3xl space-y-5">
      <PageTitle action={<ProposalStateBadge state={proposal.state} />}>
        #{proposal.number} {proposal.title}
      </PageTitle>
      <ErrorText error={details.error} />
      <ProposalOverview proposal={proposal} names={names} now={now} slug={slug}
        replaces={replaces} revisedBy={revisedBy} />
      {proposal.kind === ProposalKind.Budget && (
        <BudgetProposalView slug={slug} proposal={proposal} ownerNames={ownerNames} isAdmin={isAdmin}
          treasuryCount={activeTreasuries(treasuries.data).length} assignments={assignments} />
      )}
      {proposal.kind === ProposalKind.Workgroup && <WorkgroupProposalView slug={slug} proposal={proposal} names={names} />}
      {proposal.kind === ProposalKind.Task && (
        <TaskProposalView slug={slug} proposal={proposal} names={names}
          boardName={isTaskPayload(proposal.payload) ? ownerNames.get(proposal.payload.task.workgroupId) : undefined} />
      )}
      {isVotingOpen(proposal, now) && (
        <VotePanel key={myVote?.signed_at ?? "none"} proposal={proposal} seat={seat} myVote={myVote} onVoted={reload} />
      )}
      <ProposalResults proposal={proposal} votes={votes} names={names} />
      {community && (
        <ProposalAnchors slug={slug} communityId={community.id} proposal={proposal} anchors={anchors}
          treasuries={treasuries.data} isAdmin={isAdmin} network={asNetwork(community.network)} />
      )}
      <ProposalActions proposal={proposal} wallet={sessionWallet} isAdmin={isAdmin} onChanged={reload}
        onRevise={() => setRevising(true)} />
      <ProposalTimeline events={events} names={names} />
      <p className="text-sm"><Link className="underline" href={routes.proposals(slug)}>All proposals</Link></p>

      {revising && community && proposal.kind === ProposalKind.Budget && settings.data && (
        <ReviseBudgetDialog communityId={community.id} proposal={proposal} budgetOwners={budgetOwners}
          settings={settings.data.budget} onClose={() => setRevising(false)}
          onCreated={(newId) => router.push(routes.proposal(slug, newId))} />
      )}
      {revising && community && dialogKind && settings.data && workgroups.data && members.data && (
        <NewProposalDialog communityId={community.id} kinds={[dialogKind]} initialKind={dialogKind}
          settings={settings.data} roles={viewer} workgroups={workgroups.data} members={members.data}
          sessionWallet={sessionWallet} reviseFrom={proposal} onClose={() => setRevising(false)}
          onCreated={(newId) => router.push(routes.proposal(slug, newId))} />
      )}
    </div>
  );
}
