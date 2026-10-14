"use client";

import { useMemo } from "react";
import {
  groupTasksByGhStatus,
  mergeLiveBoard,
  type BoardTask,
  type LiveProjectBoard,
  type MergedBoard,
} from "@/lib/boardTypes";
import { TaskSource } from "@/lib/constants";
import { Badge, LinkButton } from "@/components/ui";
import { BoardColumn } from "./BoardColumn";
import { LiveItemCard } from "./LiveItemCard";
import { TaskCard } from "./TaskCard";

/** The synced-tasks-only fallback (loading / live fetch failed). */
function SyncedTasksView({
  tasks,
  canManage,
  onEdit,
}: {
  tasks: BoardTask[];
  canManage: boolean;
  onEdit: (task: BoardTask) => void;
}) {
  return (
    <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
      {groupTasksByGhStatus(tasks).map((group) => (
        <BoardColumn key={group.status ?? "(none)"} name={group.status ?? "No status"}>
          {group.tasks.map((t) => (
            <TaskCard key={t.id} task={t} canManage={canManage} onEdit={onEdit} />
          ))}
        </BoardColumn>
      ))}
    </div>
  );
}

/**
 * Native tasks of a GitHub workgroup (call attendance, tasks from before the
 * repository was linked, imported stubs): no project item to sit on, so they
 * get their own list under the live columns.
 */
function AppTasksSection({
  tasks,
  canManage,
  onEdit,
}: {
  tasks: BoardTask[];
  canManage: boolean;
  onEdit: (task: BoardTask) => void;
}) {
  if (tasks.length === 0) return null;
  return (
    <section className="mt-8" aria-labelledby="app-tasks-heading">
      <h2 id="app-tasks-heading" className="font-medium">Created in Treasury Guild</h2>
      <p className="mb-3 mt-1 text-sm text-zinc-500">
        Tasks made in Treasury Guild, such as call attendance, are paid from Payday like any other.
      </p>
      <div className="grid gap-3 md:grid-cols-2 lg:grid-cols-4">
        {tasks.map((t) => (
          <TaskCard key={t.id} task={t} canManage={canManage} onEdit={onEdit} />
        ))}
      </div>
    </section>
  );
}

function NoRepoLinked({ isAdmin, settingsHref }: { isAdmin: boolean; settingsHref: string }) {
  return (
    <div className="mx-auto max-w-md py-12 text-center">
      <p className="text-zinc-400">
        This workgroup uses a GitHub project, but no repository is linked yet.
      </p>
      {isAdmin ? (
        <LinkButton href={settingsHref} className="mt-4">
          Link a repository
        </LinkButton>
      ) : (
        <p className="mt-2 text-sm text-zinc-500">
          Ask an admin to link a repository in GitHub settings.
        </p>
      )}
    </div>
  );
}

/** Live GitHub project columns with synced tasks overlaid, then the workgroup's native tasks. */
export function GithubBoardView({
  boards,
  hasRepos,
  partial,
  error,
  tasks,
  canManage,
  isAdmin,
  settingsHref,
  onEdit,
  archived = false,
}: {
  boards: LiveProjectBoard[] | null;
  hasRepos: boolean | null;
  partial: boolean;
  error: string | null;
  tasks: BoardTask[];
  canManage: boolean;
  isAdmin: boolean;
  settingsHref: string;
  onEdit: (task: BoardTask) => void;
  archived?: boolean;
}) {
  const githubTasks = useMemo(() => tasks.filter((t) => t.source === TaskSource.Github), [tasks]);
  const appTasks = useMemo(() => tasks.filter((t) => t.source !== TaskSource.Github), [tasks]);
  const merged = useMemo(
    () => (boards ?? []).map((b) => mergeLiveBoard(b, githubTasks)),
    [boards, githubTasks],
  );
  const manage = canManage && !archived;

  return (
    <>
      <GithubColumns
        merged={merged}
        boards={boards}
        hasRepos={hasRepos}
        partial={partial}
        error={error}
        tasks={githubTasks}
        canManage={manage}
        isAdmin={isAdmin}
        settingsHref={settingsHref}
        onEdit={onEdit}
        archived={archived}
      />
      <AppTasksSection tasks={appTasks} canManage={manage} onEdit={onEdit} />
    </>
  );
}

function GithubColumns({
  merged,
  boards,
  hasRepos,
  partial,
  error,
  tasks,
  canManage,
  isAdmin,
  settingsHref,
  onEdit,
  archived,
}: {
  merged: MergedBoard[];
  boards: LiveProjectBoard[] | null;
  hasRepos: boolean | null;
  partial: boolean;
  error: string | null;
  tasks: BoardTask[];
  canManage: boolean;
  isAdmin: boolean;
  settingsHref: string;
  onEdit: (task: BoardTask) => void;
  archived: boolean;
}) {
  if (archived) return <SyncedTasksView tasks={tasks} canManage={false} onEdit={onEdit} />;
  if (hasRepos === false) {
    return <NoRepoLinked isAdmin={isAdmin} settingsHref={settingsHref} />;
  }
  if (error) {
    return (
      <>
        <p className="mb-4 text-sm text-amber-500/80">
          Showing payable tasks only — live GitHub view unavailable.
        </p>
        <SyncedTasksView tasks={tasks} canManage={canManage} onEdit={onEdit} />
      </>
    );
  }
  if (boards === null) {
    return (
      <>
        <p className="mb-4 text-sm text-zinc-500">Loading live board…</p>
        <SyncedTasksView tasks={tasks} canManage={canManage} onEdit={onEdit} />
      </>
    );
  }
  return (
    <div className="space-y-8">
      {partial && (
        <p className="text-sm text-amber-500/80">
          Some project boards could not be loaded.
        </p>
      )}
      {merged.map((board) => (
        <div key={board.projectId}>
          <div className="mb-3 flex items-center gap-2">
            <a
              href={board.url}
              target="_blank"
              rel="noreferrer"
              className="font-medium hover:text-indigo-400"
            >
              {board.title}
            </a>
            <Badge tone="blue">live</Badge>
          </div>
          <div className="grid gap-4 md:grid-cols-2 lg:grid-cols-4">
            {board.columns.map((col) => (
              <BoardColumn key={col.name} name={col.name}>
                {col.items.map((item) =>
                  item.task ? (
                    <TaskCard
                      key={item.itemNodeId}
                      task={item.task}
                      canManage={canManage}
                      onEdit={onEdit}
                    />
                  ) : (
                    <LiveItemCard key={item.itemNodeId} item={item} />
                  ),
                )}
              </BoardColumn>
            ))}
          </div>
        </div>
      ))}
      {merged.length === 0 && (
        <p className="text-zinc-400">
          No open GitHub project found for the linked repositories yet. Add
          issues to a project board on GitHub and they will appear here.
        </p>
      )}
    </div>
  );
}
