"use client";

import { Card, SectionTitle } from "@/components/ui";
import { PROPOSAL_STATE_META, type ProposalState } from "@/lib/constants";
import type { ProposalEventRow } from "@/lib/db/types";
import { formatDate, plural } from "@/lib/format";
import { voterName } from "@/lib/governance/labels";

function describe(event: ProposalEventRow, name: (wallet: string) => string): string {
  const detail = event.detail ?? {};
  const reason = typeof detail.reason === "string" ? detail.reason : null;
  switch (event.action) {
    case "created":
      return typeof detail.replaces === "number"
        ? `Proposed by ${event.actor ? name(event.actor) : "a member"} (revises #${detail.replaces})`
        : `Proposed by ${event.actor ? name(event.actor) : "a member"}`;
    case "voting_opened":
      return typeof detail.electorate === "number" ? `Voting opened for ${plural(detail.electorate, "voter")}` : "Voting opened";
    case "closed":
      return `Closed: ${PROPOSAL_STATE_META[detail.state as ProposalState]?.label ?? String(detail.state)}`;
    case "executed":
      return event.actor ? `Applied, retried by ${name(event.actor)}` : "Applied";
    case "execution_failed":
      return `Could not be applied: ${typeof detail.message === "string" ? detail.message : "error"}`;
    case "withdrawn":
      return typeof detail.revisedAs === "number"
        ? `Withdrawn by ${event.actor ? name(event.actor) : "the proposer"} (revised as #${detail.revisedAs})`
        : `Withdrawn by ${event.actor ? name(event.actor) : "the proposer"}`;
    case "cancelled":
      return event.actor ? `Cancelled by ${name(event.actor)}${reason ? `: ${reason}` : ""}` : `Cancelled: ${reason ?? ""}`;
    default:
      return event.action;
  }
}

export function ProposalTimeline({ events, names }: { events: ProposalEventRow[]; names: Map<string, string | null> }) {
  if (events.length === 0) return null;
  const name = (wallet: string) => voterName(wallet, names.get(wallet));
  return (
    <Card>
      <SectionTitle>History</SectionTitle>
      <ol className="space-y-1 text-sm">
        {events.map((event) => (
          <li key={event.id} className="flex flex-wrap justify-between gap-2">
            <span>{describe(event, name)}</span>
            <span className="text-xs text-zinc-500">{formatDate(event.occurred_at, "datetime")}</span>
          </li>
        ))}
      </ol>
    </Card>
  );
}
