"use client";

import type { GovernanceAction } from "@/lib/db/types";
import { Card, CopyButton, JsonDetails } from "@/components/ui";

/** Stake / DRep / vote payload: readable lines plus the raw details expander. */
export function GovernanceActionCard({ action }: { action: GovernanceAction | null }) {
  if (!action) return null;

  const title =
    action.kind === "stake" ? "Stake action" : action.kind === "drep" ? "DRep action" : "Vote action";

  return (
    <Card className="mb-4">
      <h3 className="mb-3 text-sm font-medium text-zinc-400">{title}</h3>
      <dl className="space-y-2 text-sm">
        {"action" in action && (
          <div className="flex justify-between gap-3">
            <dt className="text-zinc-500">Action</dt>
            <dd className="font-mono text-xs text-zinc-200">{action.action}</dd>
          </div>
        )}
        {action.kind === "stake" && action.poolTicker && (
          <div className="flex justify-between gap-3">
            <dt className="text-zinc-500">Pool</dt>
            <dd className="font-medium text-zinc-200">{action.poolTicker}</dd>
          </div>
        )}
        {action.kind === "stake" && action.poolId && (
          <div className="flex items-start justify-between gap-3">
            <dt className="shrink-0 text-zinc-500">Pool id</dt>
            <dd className="flex min-w-0 items-center gap-1.5 font-mono text-xs text-zinc-300">
              <span className="break-all">{action.poolId}</span>
              <CopyButton value={action.poolId} label="Copy pool id" />
            </dd>
          </div>
        )}
        {"dRepId" in action && action.dRepId && (
          <div className="flex items-start justify-between gap-3">
            <dt className="shrink-0 text-zinc-500">DRep</dt>
            <dd className="flex min-w-0 items-center gap-1.5 font-mono text-xs text-zinc-300">
              <span className="break-all">{action.dRepId}</span>
              <CopyButton value={action.dRepId} label="Copy DRep id" />
            </dd>
          </div>
        )}
        {action.kind === "stake" && action.rewards && action.rewards !== "0" && (
          <div className="flex justify-between gap-3">
            <dt className="text-zinc-500">Rewards</dt>
            <dd className="font-mono text-xs text-zinc-200">{action.rewards}</dd>
          </div>
        )}
        {action.kind === "vote" && (
          <div className="flex justify-between gap-3">
            <dt className="text-zinc-500">Votes</dt>
            <dd className="font-mono text-xs text-zinc-200">{action.votes.length}</dd>
          </div>
        )}
      </dl>
      <JsonDetails label="View more transaction details" value={action} />
    </Card>
  );
}
