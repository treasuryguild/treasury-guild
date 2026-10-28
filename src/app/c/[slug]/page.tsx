"use client";

import { use, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api/client";
import type { JoinCommunityResponse } from "@/lib/api/types";
import { DEFAULT_BOARD_COLUMNS } from "@/lib/boardTypes";
import { ProposalKind, TaskSource, Visibility } from "@/lib/constants";
import { mayPropose } from "@/lib/roles";
import { browserClient } from "@/lib/supabase/browser";
import { COMMUNITY_CARDS, communityHref, routes } from "@/lib/routes";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useCommunityGate } from "@/hooks/useCommunityGate";
import { useMyTreasuryRoles } from "@/hooks/useMyTreasuryRoles";
import { useGovernanceSettings } from "@/hooks/useProposals";
import { useTreasuries } from "@/hooks/useTreasuries";
import { useWorkgroups, type WorkgroupDetails } from "@/hooks/useWorkgroups";
import { NetworkBadge } from "@/components/community/NetworkNotice";
import { SetupChecklist } from "@/components/integrations/SetupChecklist";
import { WorkgroupDetailsDialog } from "@/components/workgroups/WorkgroupDetailsDialog";
import {
  Badge,
  Button,
  Card,
  ErrorText,
  Input,
  LinkButton,
  NoticeText,
  PageTitle,
  SectionTitle,
  SourceBadge,
} from "@/components/ui";

export default function CommunityDashboard({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const router = useRouter();
  const { community, role, isAdmin, reload, blocked } = useCommunityGate(slug, {
    require: "community",
  });
  const [showArchived, setShowArchived] = useState(false);
  const workgroups = useWorkgroups(community?.id, showArchived);
  const [lifecycleMessage, setLifecycleMessage] = useState("");
  const treasuries = useTreasuries(community?.id);
  const governance = useGovernanceSettings(role ? community?.id : null);
  const roles = useMyTreasuryRoles(community?.id);
  const [newName, setNewName] = useState("");
  const [newKind, setNewKind] = useState<string>(TaskSource.Native);
  const [editingWorkgroup, setEditingWorkgroup] = useState<WorkgroupDetails | null>(null);
  const [detailsSaved, setDetailsSaved] = useState(false);
  const join = useAsyncAction("Failed to join");
  const create = useAsyncAction("Could not add the workgroup");

  if (blocked) return blocked;

  if (!role) {
    // RLS hides private communities from non-members entirely, so reaching
    // this branch means the community is public — offer to join.
    return (
      <div className="mx-auto max-w-md py-12 text-center">
        <h1 className="text-2xl font-semibold">{community!.name}</h1>
        {community!.description && (
          <p className="mt-2 text-zinc-400">{community!.description}</p>
        )}
        <p className="mt-4 text-sm text-zinc-500">
          You are not a member of this community yet.
        </p>
        {community!.visibility === Visibility.Public && (
          <Button
            className="mt-4"
            loading={join.busy}
            onClick={() =>
              void join
                .run(() =>
                  apiFetch<JoinCommunityResponse>("/api/community/join", {
                    body: { communityId: community!.id },
                  }),
                )
                // Re-run the community lookup so the new role shows up.
                .then((ok) => ok && reload())
            }
          >
            {join.busy ? "Joining…" : "Join community"}
          </Button>
        )}
        <ErrorText error={join.error} className="mt-2" />
      </div>
    );
  }

  async function addWorkgroup() {
    if (!newName.trim() || !community || create.busy) return;
    const db = browserClient();
    const added = await create.run(async () => {
      const { data, error } = await db
        .from("workgroups")
        .insert({ community_id: community.id, name: newName.trim(), kind: newKind })
        .select("id, name, description, kind, treasury_id, archived_at")
        .single();
      if (error) throw new Error(error.message);
      const workgroup = data as WorkgroupDetails;
      // A GitHub board has no columns: its repo/project is linked next.
      if (newKind === TaskSource.Native) {
        const columns = await db
          .from("board_columns")
          .insert(DEFAULT_BOARD_COLUMNS.map((c) => ({ workgroup_id: workgroup.id, ...c })));
        if (columns.error) throw new Error(columns.error.message);
      }
      return workgroup;
    });
    if (!added) return;
    if (newKind === TaskSource.Github) {
      router.push(routes.githubSettings(slug));
      return;
    }
    workgroups.setData((prev) => [...(prev ?? []), added]);
    setNewName("");
  }

  const treasuryList = treasuries.data ?? [];
  // With workgroups decided by vote, nobody adds one directly (workgroups_insert refuses).
  const workgroupVote = governance.data?.workgroup;
  const canProposeWorkgroup = !!workgroupVote?.enabled &&
    mayPropose({ isAdmin, ledWorkgroupIds: roles.ledWorkgroupIds }, workgroupVote.proposers, []);

  return (
    <div>
      <PageTitle
        action={
          <span className="flex gap-1.5">
            <NetworkBadge network={community!.network} />
            <Badge tone="blue">{role}</Badge>
          </span>
        }
      >
        {community!.name}
      </PageTitle>

      {isAdmin && community && (
        <SetupChecklist communityId={community.id} slug={slug} />
      )}

      <div className="mb-8 grid auto-rows-fr gap-4 sm:grid-cols-2 lg:grid-cols-4">
        {COMMUNITY_CARDS.map((card) => (
          <Link key={card.key} href={communityHref(card.key, slug)}>
            <Card className="h-full transition-colors hover:border-indigo-600">
              <h3 className="font-medium">{card.title}</h3>
              <p className="mt-1 text-sm text-zinc-400">{card.blurb}</p>
            </Card>
          </Link>
        ))}
      </div>

      <SectionTitle>Workgroups & projects</SectionTitle>
      <label className="mb-4 flex items-center gap-2 text-sm text-zinc-400">
        <input type="checkbox" checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} /> Show archived
      </label>
      <NoticeText className="mb-4">{lifecycleMessage}</NoticeText>
      <ErrorText error={workgroups.error} className="mb-4" />
      <NoticeText className="mb-4">{detailsSaved && "Workgroup / project details saved."}</NoticeText>
      <div className="grid gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {(workgroups.data ?? []).map((w) => (
          <Card key={w.id} className="relative isolate transition-colors hover:border-indigo-600">
            {/* Stretch the board link across the card; keep secondary actions above it. */}
            <Link
              href={routes.board(slug, w.id)}
              className="block min-w-0 after:absolute after:inset-0 after:rounded-2xl after:content-[''] focus-visible:after:outline-2 focus-visible:after:outline-offset-3 focus-visible:after:outline-(--accent)"
            >
              <div className="flex min-w-0 items-center justify-between gap-2">
                <h3 className="min-w-0 font-medium">{w.name}</h3>
                {w.archived_at && <Badge>Archived</Badge>}
                <SourceBadge source={w.kind} />
              </div>
            </Link>
            {w.description && <p className="mt-2 line-clamp-3 whitespace-pre-wrap break-words text-sm text-zinc-400">{w.description}</p>}
            {w.treasury_id && (
              <p className="mt-3 text-xs text-zinc-500">
                Paid from{" "}
                {treasuryList.find((t) => t.id === w.treasury_id)?.name ??
                  "assigned wallet"}
              </p>
            )}
            {isAdmin && (
              <Button variant="secondary" className="relative z-10 mt-3" aria-label={`Edit details for ${w.name}`} onClick={() => { setDetailsSaved(false); setEditingWorkgroup(w); }}>
                Edit details
              </Button>
            )}
          </Card>
        ))}
        {workgroupVote?.enabled && (
          <Card>
            <p className="text-sm text-zinc-400">New workgroups are created by a community vote.</p>
            {canProposeWorkgroup && (
              <LinkButton className="mt-3" href={routes.proposals(slug, { kind: ProposalKind.Workgroup })}>Propose a workgroup</LinkButton>
            )}
          </Card>
        )}
        {isAdmin && governance.data && !workgroupVote?.enabled && (
          <Card>
            <div className="grid gap-2 sm:grid-cols-[minmax(0,1fr)_auto]">
              <Input
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
                placeholder="New workgroup name"
                onKeyDown={(e) => e.key === "Enter" && void addWorkgroup()}
              />
              <Button loading={create.busy} onClick={() => void addWorkgroup()}>Add</Button>
            </div>
            <ErrorText error={create.error} className="mt-2" />
            <div className="mt-3 flex flex-col gap-1.5">
              <label className="flex cursor-pointer items-start gap-2 text-xs text-zinc-400">
                <input
                  type="radio"
                  name="board-kind"
                  className="mt-0.5"
                  checked={newKind === TaskSource.Native}
                  onChange={() => setNewKind(TaskSource.Native)}
                />
                <span>
                  <span className="text-zinc-200">App board</span> — simple
                  kanban with a payable column, tasks created here
                </span>
              </label>
              <label className="flex cursor-pointer items-start gap-2 text-xs text-zinc-400">
                <input
                  type="radio"
                  name="board-kind"
                  className="mt-0.5"
                  checked={newKind === TaskSource.Github}
                  onChange={() => setNewKind(TaskSource.Github)}
                />
                <span>
                  <span className="text-zinc-200">GitHub project</span> — sync
                  issues from a repo&apos;s project board
                </span>
              </label>
            </div>
          </Card>
        )}
      </div>
      {isAdmin && editingWorkgroup && community && (
        <WorkgroupDetailsDialog
          workgroup={editingWorkgroup}
          communityId={community.id}
          slug={slug}
          onClose={() => setEditingWorkgroup(null)}
          onLifecycleChanged={(action) => {
            setEditingWorkgroup(null);
            setDetailsSaved(false);
            setLifecycleMessage(action === "delete" ? "Empty workgroup deleted." : action === "archive" ? "Workgroup archived. Use Show archived to find it." : "Workgroup restored.");
            workgroups.reload();
          }}
          onSaved={(updated) => {
            workgroups.setData((prev) => (prev ?? []).map((workgroup) => workgroup.id === updated.id ? updated : workgroup));
            setEditingWorkgroup(null);
            setDetailsSaved(true);
          }}
        />
      )}
    </div>
  );
}
