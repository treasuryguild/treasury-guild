"use client";

import { use, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { toMemberOptions, type BoardTask } from "@/lib/boardTypes";
import { appNetwork, asNetwork } from "@/lib/config";
import { ProposalKind, TaskSource } from "@/lib/constants";
import { routes } from "@/lib/routes";
import { useBoardData } from "@/hooks/useBoardData";
import { useBoardMutations } from "@/hooks/useBoardMutations";
import { useCommunityGate } from "@/hooks/useCommunityGate";
import { useCommunityMembers } from "@/hooks/useCommunityMembers";
import { useLiveBoard } from "@/hooks/useLiveBoard";
import { useMyTreasuryRoles } from "@/hooks/useMyTreasuryRoles";
import { useGovernanceSettings } from "@/hooks/useProposals";
import { useTreasuryTokenTickers } from "@/hooks/useTreasuryTokenTickers";
import { useWorkgroupBudgetSetups } from "@/hooks/useWorkgroupBudgetSetups";
import { Button, ErrorText, LinkButton, NoticeText, PageMessage, PageTitle } from "@/components/ui";
import { WorkgroupDetailsDialog } from "@/components/workgroups/WorkgroupDetailsDialog";
import { EmptyBoardChooser } from "@/components/board/EmptyBoardChooser";
import { GithubBoardView } from "@/components/board/GithubBoardView";
import { NativeBoardView } from "@/components/board/NativeBoardView";
import { TaskModal } from "@/components/board/TaskModal";
import { TaskLifecycleDialog } from "@/components/board/TaskLifecycleDialog";
import { managesWorkgroup, mayPropose } from "@/lib/roles";

export default function BoardPage({
  params,
}: {
  params: Promise<{ slug: string; workgroupId: string }>;
}) {
  const { slug, workgroupId } = use(params);
  const router = useRouter();
  const { community, role, isAdmin, blocked } = useCommunityGate(slug);
  const isMember = !!role;

  const board = useBoardData(workgroupId, isMember);
  const isGithubBoard = board.workgroup?.kind === TaskSource.Github;
  const archived = !!board.workgroup?.archived_at;
  const live = useLiveBoard(workgroupId, isMember && board.loaded && isGithubBoard && !archived);
  const members = useCommunityMembers(isMember ? community?.id : null);
  const roles = useMyTreasuryRoles(community?.id);
  const tokenTickers = useTreasuryTokenTickers(
    community?.id,
    board.workgroup?.treasury_id ?? null,
    isMember && board.loaded,
  );
  const budgetSetups = useWorkgroupBudgetSetups(workgroupId, isMember && board.loaded);
  const governance = useGovernanceSettings(isMember ? community?.id : null);
  const mutations = useBoardMutations({
    workgroupId,
    columns: board.columns,
    tasks: board.tasks,
    reload: board.reload,
  });
  const [editing, setEditing] = useState<BoardTask | null>(null);
  const [managingTask, setManagingTask] = useState<BoardTask | null>(null);
  const [showArchivedTasks, setShowArchivedTasks] = useState(false);
  const [taskNotice, setTaskNotice] = useState<string | null>(null);
  const [editingDetails, setEditingDetails] = useState(false);
  const [detailsSaved, setDetailsSaved] = useState(false);
  const memberOptions = useMemo(
    () => toMemberOptions(members.data ?? []),
    [members.data],
  );

  if (blocked) return blocked;

  // Board writes are RLS-gated to admins and this workgroup's leads; the UI
  // must match or member edits would silently no-op (0 rows updated).
  const canManage = !!board.workgroup && !archived && managesWorkgroup({ isAdmin, ...roles }, workgroupId);
  const settingsHref = routes.githubSettings(slug);
  const isEmptyNative =
    board.loaded && board.columns.length === 0 && board.tasks.length === 0;
  const archivedTasks = board.tasks.filter((task) => !!task.archived_at);
  const taskVote = governance.data?.task;
  const canProposeTask = !!board.workgroup && !archived && !isGithubBoard && !!taskVote?.enabled &&
    mayPropose({ isAdmin, ...roles }, taskVote.proposers, [workgroupId]);
  const activeTasks = board.tasks.filter((task) => !task.archived_at);

  return (
    <div>
      <PageTitle action={(isAdmin && board.workgroup) || canProposeTask ? (
        <span className="flex flex-wrap gap-2">
          {canProposeTask && (
            <LinkButton variant="secondary" href={routes.proposals(slug, { kind: ProposalKind.Task, workgroupId })}>Propose a task</LinkButton>
          )}
          {isAdmin && board.workgroup && (
            <Button variant="secondary" onClick={() => { setDetailsSaved(false); setEditingDetails(true); }}>Edit details</Button>
          )}
        </span>
      ) : undefined}>{board.workgroup?.name ?? ""}</PageTitle>
      {archived && <p role="status" className="mb-4 rounded border border-zinc-700 p-3 text-sm text-zinc-400">Archived — this board is read-only. Historical tasks, budgets, and payments remain available.</p>}
      {board.loaded && !board.workgroup && !board.error && <PageMessage>Workgroup not found.</PageMessage>}
      {board.workgroup?.description && <p className="mb-4 whitespace-pre-wrap break-words text-sm text-zinc-400">{board.workgroup.description}</p>}
      <NoticeText className="mb-4">{detailsSaved && "Workgroup / project details saved."}</NoticeText>
      <ErrorText error={mutations.error ?? board.error} className="mb-4" />
      <NoticeText className="mb-4">{taskNotice}</NoticeText>
      {board.loaded && board.workgroup && <div className="mb-4 flex flex-wrap gap-2">
        <Button variant={showArchivedTasks ? "secondary" : "primary"} aria-pressed={!showArchivedTasks}
          onClick={() => setShowArchivedTasks(false)}>Board</Button>
        <Button variant={showArchivedTasks ? "primary" : "secondary"} aria-pressed={showArchivedTasks}
          onClick={() => setShowArchivedTasks(true)}>Archived tasks ({archivedTasks.length})</Button>
      </div>}
      {isAdmin && editingDetails && board.workgroup && community && (
        <WorkgroupDetailsDialog workgroup={{ id: workgroupId, ...board.workgroup }} communityId={community.id} slug={slug}
          onClose={() => setEditingDetails(false)}
          onLifecycleChanged={(action) => {
            setEditingDetails(false); setEditing(null); setDetailsSaved(false);
            if (action === "delete") router.push(routes.community(slug));
            else board.reload();
          }}
          onSaved={() => { setEditingDetails(false); setDetailsSaved(true); board.reload(); }} />
      )}

      {showArchivedTasks ? (
        archivedTasks.length === 0 ? <PageMessage>No archived tasks.</PageMessage> : <div className="space-y-3">
          {archivedTasks.map((task) => <div key={task.id} className="glass-panel flex items-start justify-between gap-3 rounded-xl p-4">
            <div className="min-w-0">
              <p className="break-words text-sm">{task.title}</p>
              {task.body && <p className="mt-1 whitespace-pre-wrap break-words text-xs text-zinc-400">{task.body}</p>}
            </div>
            {canManage && <Button variant="secondary" aria-label={`Manage archived task: ${task.title}`}
              onClick={() => setManagingTask(task)}>Manage</Button>}
          </div>)}
        </div>
      ) : isGithubBoard ? (
        <GithubBoardView
          boards={live.boards}
          hasRepos={live.hasRepos}
          partial={live.partial}
          error={live.error}
          tasks={activeTasks}
          canManage={canManage}
          isAdmin={isAdmin}
          settingsHref={settingsHref}
          onEdit={setEditing}
          archived={archived}
        />
      ) : isEmptyNative ? (
        canManage ? (
          <EmptyBoardChooser
            onUseAppBoard={mutations.seedAppBoard}
            settingsHref={settingsHref}
            isAdmin={isAdmin}
          />
        ) : (
          <PageMessage>This board hasn&apos;t been set up yet.</PageMessage>
        )
      ) : (
        <NativeBoardView
          columns={board.columns}
          tasks={activeTasks}
          canManage={canManage}
          onMove={(taskId, columnId) => void mutations.moveTask(taskId, columnId)}
          onAdd={mutations.addTask}
          onEdit={setEditing}
        />
      )}

      {editing && canManage && (
        <TaskModal
          task={editing}
          members={memberOptions}
          tokenTickers={tokenTickers}
          network={community ? asNetwork(community.network) : appNetwork()}
          budgetSetups={budgetSetups}
          busy={mutations.busy}
          saveError={mutations.error}
          onArchive={() => { setManagingTask(editing); setEditing(null); }}
          onClose={() => setEditing(null)}
          onSave={(fields) =>
            void mutations.saveTask(editing, fields).then((ok) => ok && setEditing(null))
          }
          onRename={(title) =>
            void mutations.renameTask(editing, title).then((ok) => ok && setEditing(null))
          }
        />
      )}
      {managingTask && canManage && <TaskLifecycleDialog task={managingTask}
        onClose={() => setManagingTask(null)}
        onChanged={(action) => {
          setManagingTask(null);
          setTaskNotice(action === "archive" ? "Task archived. You can restore it from Archived tasks."
            : action === "restore" ? "Task restored to the board." : "Task permanently deleted.");
          board.reload();
        }} />}
    </div>
  );
}
