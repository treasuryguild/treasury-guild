"use client";

// What a task proposal adds to its board when it passes, and a link once it did.
import Link from "next/link";
import { Card, SectionTitle } from "@/components/ui";
import type { ProposalRow } from "@/lib/db/types";
import { voterName } from "@/lib/governance/labels";
import { isTaskPayload } from "@/lib/governance/payload";
import { routes } from "@/lib/routes";

export function TaskProposalView({ slug, proposal, boardName, names }: {
  slug: string;
  proposal: ProposalRow;
  boardName: string | undefined;
  names: Map<string, string | null>;
}) {
  if (!isTaskPayload(proposal.payload)) return null;
  const { task } = proposal.payload;
  const bounty = Object.entries(task.amounts).map(([ticker, amount]) => `${amount} ${ticker}`).join(" + ");
  return (
    <Card>
      <SectionTitle action={proposal.execution_result?.taskId
        ? <Link className="text-sm underline" href={routes.board(slug, task.workgroupId)}>Open the board</Link>
        : undefined}>
        Task
      </SectionTitle>
      <dl className="grid gap-x-4 gap-y-1 text-sm sm:grid-cols-[auto_1fr]">
        <dt className="text-zinc-500">Board</dt>
        <dd>{boardName ?? "A deleted workgroup"}</dd>
        <dt className="text-zinc-500">Bounty</dt>
        <dd>{bounty || "None"} per assignee</dd>
        <dt className="text-zinc-500">Assignee</dt>
        <dd>{task.assignSelf ? voterName(proposal.proposer, names.get(proposal.proposer)) : "None yet"}</dd>
      </dl>
      <p className="mt-4 text-xs text-zinc-500">
        When the proposal passes, the task is added to this app board&apos;s first column with this title and description. It is
        not payable yet: its workgroup&apos;s leads move it through the board as with any task. Task proposals never create
        GitHub issues.
      </p>
    </Card>
  );
}
