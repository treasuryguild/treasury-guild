"use client";

import { use, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { BudgetsResponse } from "@/lib/api/types";
import { budgetMonthFromQuery, budgetPeriod, monthDate, monthOf, quarterMonths, shortMonthLabel } from "@/lib/budgets";
import { routes } from "@/lib/routes";
import { useAsyncData } from "@/hooks/useAsyncData";
import { useAssetRegistry } from "@/hooks/useAssetRegistry";
import { useCommunityGate } from "@/hooks/useCommunityGate";
import { useMyTreasuryRoles } from "@/hooks/useMyTreasuryRoles";
import { useGovernanceSettings, useOpenBudgetProposals } from "@/hooks/useProposals";
import { useTreasuries } from "@/hooks/useTreasuries";
import { useWorkgroups } from "@/hooks/useWorkgroups";
import { BudgetWorksheet } from "@/components/budgets/BudgetWorksheet";
import { BudgetPeriodPicker, type BudgetView } from "@/components/budgets/BudgetPeriodPicker";
import { Button, Card, ErrorText, PageTitle } from "@/components/ui";

export default function BudgetsPage({ params, searchParams }: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ month?: string | string[]; view?: string }>;
}) {
  const { slug } = use(params);
  const query = use(searchParams);
  const month = budgetMonthFromQuery(query.month);
  const view = query.view === "quarter" ? "quarter" : "month";
  return <BudgetsView key={`${slug}:${month}:${view}`} slug={slug} initialMonth={month} initialView={view} />;
}

function BudgetsView({ slug, initialMonth, initialView }: { slug: string; initialMonth: string; initialView: BudgetView }) {
  const { community, isAdmin, blocked } = useCommunityGate(slug);
  const workgroups = useWorkgroups(community?.id, true);
  const treasuries = useTreasuries(community?.id);
  const roles = useMyTreasuryRoles(community?.id);
  const registry = useAssetRegistry(community?.id);
  const governance = useGovernanceSettings(community?.id);
  const openProposals = useOpenBudgetProposals(community?.id);
  const [month, setMonth] = useState(initialMonth);
  const [view, setView] = useState<BudgetView>(initialView);
  const [dirty, setDirty] = useState(false);
  const [busy, setBusy] = useState(false);
  const scope = community ? `${community.id}:${month}:${view}` : null;
  const dashboard = useAsyncData(scope, () => loadBudgets());

  function loadBudgets() {
    return apiFetch<BudgetsResponse>("/api/budgets", {
      query: { communityId: community!.id, month, view },
    });
  }

  function changePeriod(nextMonth: string, nextView = view) {
    if (busy || !/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(nextMonth)) return;
    if (dirty && !window.confirm("Discard all unsaved budget changes before changing period?")) return;
    setDirty(false);
    setMonth(nextMonth);
    setView(nextView);
  }

  const cadence = view === "quarter" ? "quarterly" : "monthly";
  const period = budgetPeriod(cadence, monthDate(month));
  const periodStart = monthOf(period.start);
  const months = quarterMonths(periodStart);
  const title = view === "recurring" ? "Recurring defaults"
    : view === "quarter" ? `${period.label} · ${shortMonthLabel(months[0]!).slice(0, 3)}–${shortMonthLabel(months[2]!).slice(0, 3)}`
      : period.label;

  if (blocked) return blocked;

  const budgetSettings = governance.data?.budget;
  const consent = budgetSettings?.enabled && openProposals.data ? {
    settings: budgetSettings,
    openProposals: openProposals.data,
    proposalHref: (id: string) => routes.proposal(slug, id),
    onProposed: () => openProposals.reload(),
  } : undefined;

  return (
    <div>
      <PageTitle>Budgets</PageTitle>
      <p className="-mt-3 mb-5 text-sm text-zinc-400">
        Plan across your workgroups and projects. Edit amounts in place, then save your changes together.
        {budgetSettings?.enabled && <> Budget consent is on: changes go to a <a className="underline" href={routes.proposals(slug)}>vote</a> and apply when it passes.</>}
      </p>
      <Card className="mb-5">
        <div className="flex flex-wrap items-end gap-3">
          <BudgetPeriodPicker month={month} view={view} disabled={busy} onChange={changePeriod} />
          <a className="app-button app-button-secondary sm:ml-auto"
            href={routes.dashboard(slug, { month: periodStart, view: view === "quarter" ? "quarter" : "month" })}
            onClick={(event) => {
              if (busy) event.preventDefault();
            }}>
            View spending
          </a>
        </div>
        <p className="mt-3 text-xs text-zinc-500">
          {view === "recurring"
            ? "Recurring amounts have a dated history. Select a month to view the setup effective then."
            : view === "quarter"
              ? "Every project appears here: a monthly project shows one cell per month, a quarterly project one cell for the quarter. Changing this view does not change any budgets."
              : "Every project appears here: a quarterly project shows its quarter read-only, edited from the quarter view. Changing this view does not change any budgets."}
        </p>
      </Card>

      {dashboard.error || workgroups.error ? (
        <Card>
          <ErrorText error={dashboard.error ?? workgroups.error} />
          <Button variant="secondary" onClick={() => { dashboard.reload(); workgroups.reload(); }}>Try again</Button>
        </Card>
      ) : dashboard.loading || workgroups.loading || governance.loading || openProposals.loading || !dashboard.data || !community ? (
        <p role="status" className="py-10 text-sm text-zinc-500">Loading budget worksheet…</p>
      ) : (
        <BudgetWorksheet key={scope} communityId={community.id} month={view === "recurring" ? null : periodStart} view={view}
          title={title} budgets={dashboard.data.budgets} setups={dashboard.data.setups} selectedMonth={month} workgroups={workgroups.data ?? []}
          treasuries={treasuries.data ?? []} assets={registry.data ?? []}
          isAdmin={isAdmin} ledWorkgroupIds={roles.ledWorkgroupIds}
          onDirtyChange={setDirty} onBusyChange={setBusy} consent={consent}
          onOpenQuarter={(quarterStart) => changePeriod(quarterStart, "quarter")}
          onRefresh={async () => { dashboard.setData(await loadBudgets()); }} />
      )}
      <ErrorText error={treasuries.error ?? registry.error ?? governance.error ?? openProposals.error} className="mt-4" />
    </div>
  );
}
