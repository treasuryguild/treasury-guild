"use client";

// What a budget proposal changes when it passes: each project's budget
// saves, in the order they apply. Once applied, an admin can fund a
// workgroup's period from another treasury with "Fund this budget", a
// prefilled transfer that cites this proposal (phase 5 of the anchoring work).
import Link from "next/link";
import { Card, LinkButton, SectionTitle } from "@/components/ui";
import { budgetOwnerLabel } from "@/lib/budgetSetups";
import { currentBudgetMonth, periodLabel } from "@/lib/budgets";
import { budgetStepText } from "@/lib/governance/describe";
import { fundBudgetPrefill } from "@/lib/governance/fundBudget";
import { budgetOwnerKey, isBudgetPayload, type BudgetStep } from "@/lib/governance/payload";
import type { ProposalRow } from "@/lib/db/types";
import { routes } from "@/lib/routes";
import type { TreasuryAssignment } from "@/lib/workgroupRouting";

export function BudgetProposalView({ slug, proposal, ownerNames, isAdmin = false, treasuryCount = 0, assignments }: {
  slug: string;
  proposal: ProposalRow;
  /** Workgroup and treasury names by id. */
  ownerNames: Map<string, string>;
  /** Admins see "Fund this budget" on an applied proposal. */
  isAdmin?: boolean;
  /** How many treasuries the community has; funding needs one to pay from besides the receiver. */
  treasuryCount?: number;
  /** Each workgroup's dated wallet routing, for the treasury a period is funded into. */
  assignments?: ReadonlyMap<string, TreasuryAssignment[]>;
}) {
  if (!isBudgetPayload(proposal.payload)) return null;
  const groups = new Map<string, BudgetStep[]>();
  for (const step of proposal.payload.steps) {
    const key = budgetOwnerKey(step);
    groups.set(key, [...(groups.get(key) ?? []), step]);
  }
  const today = currentBudgetMonth();
  return (
    <Card>
      <SectionTitle action={<Link className="text-sm underline" href={routes.budgets(slug)}>Open Budgets</Link>}>
        Budget changes
      </SectionTitle>
      <ul className="space-y-3 text-sm">
        {[...groups.values()].map((steps) => {
          const first = steps[0]!;
          const name = ownerNames.get((first.workgroupId ?? first.treasuryId)!) ?? "A deleted project";
          return (
            <li key={budgetOwnerKey(first)}>
              <p className="font-medium">{budgetOwnerLabel(first.workgroupId ? "workgroup" : "treasury", name)}</p>
              <ul className="mt-1 space-y-1 text-zinc-400">
                {steps.map((step, index) => {
                  const prefill = isAdmin && assignments ? fundBudgetPrefill(step, proposal, assignments, treasuryCount, today) : null;
                  return (
                    <li key={index}>
                      {budgetStepText(step)}
                      {step.confirm && <span className="text-amber-500"> · changes the budget setup</span>}
                      {step.reason && <span className="block text-xs text-zinc-500">Reason: {step.reason}</span>}
                      {prefill && (
                        <span className="mt-1 block">
                          <LinkButton variant="secondary" href={routes.payments(slug, prefill)}>
                            Fund this budget ({periodLabel(prefill.month, step.cadence)})
                          </LinkButton>
                          <span className="ml-2 text-xs text-zinc-500">
                            a transfer to {ownerNames.get(prefill.treasuryId) ?? "its treasury"}, citing this proposal
                          </span>
                        </span>
                      )}
                    </li>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ul>
      <p className="mt-4 text-xs text-zinc-500">
        Applied as one change when the proposal passes, recorded in each project&apos;s budget history as &quot;Proposal #{proposal.number}&quot;.
        If any of these budgets is changed in between, nothing is applied.
      </p>
    </Card>
  );
}
