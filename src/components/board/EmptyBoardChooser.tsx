"use client";

// Shown to managers on a native workgroup with no columns and no tasks:
// pick the app's own kanban or go link a GitHub project.

import { useState } from "react";
import { Button, Card, LinkButton } from "@/components/ui";

export function EmptyBoardChooser({
  onUseAppBoard,
  settingsHref,
  isAdmin,
}: {
  onUseAppBoard: () => Promise<void>;
  settingsHref: string;
  isAdmin: boolean;
}) {
  const [busy, setBusy] = useState(false);

  return (
    <div className="mx-auto grid max-w-2xl gap-4 py-8 sm:grid-cols-2">
      <Card className="flex flex-col">
        <h3 className="font-medium">📋 Use the app&apos;s board</h3>
        <p className="mt-1 flex-1 text-sm text-zinc-400">
          A simple kanban with To Do, In Progress, Done and a payable Audited
          column. Create tasks with multi-token bounties, no GitHub needed.
        </p>
        <Button
          className="mt-4 self-start"
          disabled={busy}
          onClick={() => {
            setBusy(true);
            void onUseAppBoard().finally(() => setBusy(false));
          }}
        >
          {busy ? "Setting up…" : "Use app board"}
        </Button>
      </Card>
      <Card className="flex flex-col">
        <h3 className="font-medium">🐙 Connect a GitHub project</h3>
        <p className="mt-1 flex-1 text-sm text-zinc-400">
          Link a repository and its project board — issues sync in
          automatically and the full board shows here.
        </p>
        {isAdmin ? (
          <LinkButton href={settingsHref} variant="secondary" className="mt-4 self-start">
            Open GitHub settings
          </LinkButton>
        ) : (
          <p className="mt-4 text-xs text-zinc-500">
            GitHub settings are admin-only — ask an admin to link a repo.
          </p>
        )}
      </Card>
    </div>
  );
}
