"use client";

// Proposals: decisions, new workgroups and tasks put to the community's vote,
// open ones first. Budget proposals are made from the Budgets page when
// budget consent is on. ?new=<kind>[&workgroupId=] opens the form (the
// overview and board pages link here).
import Link from "next/link";
import { useRouter } from "next/navigation";
import { use, useState } from "react";
import { Button, EmptyState, ErrorText, PageTitle, SectionTitle } from "@/components/ui";
import {
  DIALOG_KINDS, NewProposalDialog, proposableKinds, type DialogKind,
} from "@/components/governance/NewProposalDialog";
import { AnchorsDueNotice } from "@/components/governance/AnchorsDueNotice";
import { ProposalList } from "@/components/governance/ProposalList";
import { IntegrationsNotice } from "@/components/integrations/IntegrationsNotice";
import { TaskSource } from "@/lib/constants";
import { isOpenProposal } from "@/lib/governance/lifecycle";
import { routes } from "@/lib/routes";
import { useCommunityGate } from "@/hooks/useCommunityGate";
import { useCommunityMembers } from "@/hooks/useCommunityMembers";
import { useMyTreasuryRoles } from "@/hooks/useMyTreasuryRoles";
import { useNow } from "@/hooks/useNow";
import { useGovernanceSettings, useMyProposalVotes, useProposals } from "@/hooks/useProposals";
import { useTreasuries } from "@/hooks/useTreasuries";
import { useWorkgroups } from "@/hooks/useWorkgroups";

export default function ProposalsPage({ params, searchParams }: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ new?: string; workgroupId?: string }>;
}) {
  const { slug } = use(params);
  const query = use(searchParams);
  const router = useRouter();
  const { community, isAdmin, sessionWallet, blocked } = useCommunityGate(slug);
  const proposals = useProposals(community?.id);
  const myVotes = useMyProposalVotes(community?.id, sessionWallet);
  const settings = useGovernanceSettings(community?.id);
  const roles = useMyTreasuryRoles(community?.id);
  const workgroups = useWorkgroups(community?.id);
  const members = useCommunityMembers(community?.id);
  const treasuries = useTreasuries(community?.id);
  const now = useNow();
  const requested = DIALOG_KINDS.find((kind) => kind === query.new);
  const [creating, setCreating] = useState<DialogKind | "any" | null>(requested ?? null);

  if (blocked) return blocked;

  const viewer = { isAdmin, ledWorkgroupIds: roles.ledWorkgroupIds };
  const groups = workgroups.data ?? [];
  const kinds = settings.data ? proposableKinds(settings.data, viewer, groups) : [];
  const anyOn = !!settings.data && Object.values(settings.data).some((s) => s.enabled);
  const taskProposalsOn = !!settings.data?.task.enabled;
  const hasAppBoard = groups.some((w) => w.kind === TaskSource.Native && !w.archived_at);
  const all = proposals.data ?? [];
  const open = all.filter((p) => isOpenProposal(p.state));
  const closed = all.filter((p) => !isOpenProposal(p.state));

  return (
    <div className="space-y-6">
      <PageTitle action={kinds.length > 0 ? <Button onClick={() => setCreating("any")}>New proposal</Button> : undefined}>
        Proposals
      </PageTitle>
      <p className="-mt-3 max-w-3xl text-sm text-zinc-400">
        Decisions the community votes on. Every ballot is signed with the voter&apos;s wallet and can be checked by anyone.
        {settings.data?.budget.enabled && <> Budget changes are proposed from <Link className="underline" href={routes.budgets(slug)}>Budgets</Link> and apply when they pass.</>}
      </p>
      <ErrorText error={proposals.error ?? myVotes.error ?? settings.error} />
      {isAdmin && community && (
        <IntegrationsNotice communityId={community.id} slug={slug} kind="proposals-channel" />
      )}
      {community && <AnchorsDueNotice slug={slug} communityId={community.id} treasuries={treasuries.data} isAdmin={isAdmin} />}
      {settings.data && !anyOn && (
        <EmptyState>
          Voting is off in this community.{" "}
          {isAdmin
            ? <>Turn on the kinds of proposals you want under <Link className="underline" href={routes.governanceSettings(slug)}>Governance</Link>.</>
            : "An admin can turn it on under Governance."}
        </EmptyState>
      )}
      {taskProposalsOn && workgroups.data && !hasAppBoard && (
        <EmptyState>
          Task proposals need an{" "}
          <Link className="underline" href={routes.doc("workgroups-boards") + "#proposing-a-task"}>app board</Link>
          . GitHub boards keep using issues — add them from the board or on GitHub; they become tasks here when they match the{" "}
          <Link className="underline" href={routes.doc("github") + "#which-issues-become-tasks"}>import rule</Link>.
        </EmptyState>
      )}

      <section>
        <SectionTitle>Open</SectionTitle>
        {proposals.data && open.length === 0
          ? <EmptyState>No open proposals.</EmptyState>
          : <ProposalList slug={slug} proposals={open} now={now}
              myVotes={myVotes.data?.myVotes} mySeats={myVotes.data?.mySeats} />}
      </section>
      {closed.length > 0 && (
        <section>
          <SectionTitle>Closed</SectionTitle>
          <ProposalList slug={slug} proposals={closed} now={now}
            myVotes={myVotes.data?.myVotes} mySeats={myVotes.data?.mySeats} />
        </section>
      )}

      {creating && community && settings.data && workgroups.data && members.data && kinds.length > 0 && (
        <NewProposalDialog communityId={community.id} kinds={kinds} initialKind={creating === "any" ? undefined : creating}
          initialWorkgroupId={query.workgroupId} settings={settings.data} roles={viewer} workgroups={workgroups.data}
          members={members.data} sessionWallet={sessionWallet}
          onClose={() => { setCreating(null); if (requested) router.replace(routes.proposals(slug)); }}
          onCreated={(id) => router.push(routes.proposal(slug, id))} />
      )}
    </div>
  );
}
