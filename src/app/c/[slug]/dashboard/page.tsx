"use client";

import { use, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { DashboardResponse } from "@/lib/api/types";
import { unitDisplayFromRegistry } from "@/lib/assetRegistry";
import { ADA_ASSET, LOVELACE } from "@/lib/assets";
import { budgetMonthFromQuery, budgetPeriod, currentBudgetMonth, inBudgetPeriod, monthDate, quarterMonths } from "@/lib/budgets";
import { budgetOwnerLabel, setupAt } from "@/lib/budgetSetups";
import {
  ALL_WORKGROUPS,
  BUDGETED_TOKENS,
  budgetTableRows,
  budgetTableTotals,
  chartUnits,
  contributorsTasksRows,
  monthsForOwner,
  tokenOptions,
  treasurySpendingRows,
  workgroupSpendingRows,
  type DashboardView,
} from "@/lib/dashboardSeries";
import { shortUnit } from "@/lib/format";
import { legacyWalletLabel } from "@/lib/legacyHistory/display";
import { flowUnits, fundingFlowGraph } from "@/lib/fundingFlow";
import { routes } from "@/lib/routes";
import { useAssetRegistry } from "@/hooks/useAssetRegistry";
import { useAsyncData } from "@/hooks/useAsyncData";
import { useCommunityGate } from "@/hooks/useCommunityGate";
import { useWorkgroups } from "@/hooks/useWorkgroups";
import { BudgetTable } from "@/components/dashboard/BudgetTable";
import { ContributorsTasksChart } from "@/components/dashboard/ContributorsTasksChart";
import { DashboardFilters } from "@/components/dashboard/DashboardFilters";
import { FundingFlowChart } from "@/components/dashboard/FundingFlowChart";
import { IncomingPanel } from "@/components/dashboard/IncomingPanel";
import { SpendingDetailList } from "@/components/dashboard/SpendingDetailList";
import { TreasurySpendingChart } from "@/components/dashboard/TreasurySpendingChart";
import { WorkgroupSpendingChart } from "@/components/dashboard/WorkgroupSpendingChart";
import { Card, ErrorText, LinkButton, PageTitle } from "@/components/ui";

export default function DashboardPage({ params, searchParams }: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ month?: string | string[]; view?: string }>;
}) {
  const { slug } = use(params);
  const query = use(searchParams);
  const initialMonth = budgetMonthFromQuery(query.month);
  const initialView: DashboardView = query.view === "quarter" || query.view === "all" ? query.view : "month";
  return <DashboardContent key={`${slug}:${initialMonth}:${initialView}`} slug={slug} initialMonth={initialMonth} initialView={initialView} />;
}

function DashboardContent({ slug, initialMonth, initialView }: { slug: string; initialMonth: string; initialView: DashboardView }) {
  const { community, blocked } = useCommunityGate(slug);
  const workgroups = useWorkgroups(community?.id, true);
  const registry = useAssetRegistry(community?.id);
  const [month, setMonth] = useState(initialMonth);
  const [view, setView] = useState<DashboardView>(initialView);
  const [workgroupId, setWorkgroupId] = useState(ALL_WORKGROUPS);
  const [unit, setUnit] = useState(BUDGETED_TOKENS);
  const allTime = view === "all";
  const mainUnit = community?.spending_unit ?? LOVELACE;
  const dashboard = useAsyncData(community ? `${community.id}:${month}:${view}` : null, () =>
    apiFetch<DashboardResponse>("/api/dashboard", {
      query: { communityId: community!.id, month, view },
    }),
  );
  const data = dashboard.data;

  // Tickers and decimals: the registry, plus what the budgets carry for
  // tokens the treasury no longer holds, plus what imported history recorded
  // for tokens neither knows.
  const display = useMemo(() => {
    const byUnit = new Map((registry.data ?? []).map((asset) => [asset.unit, asset]));
    for (const asset of data?.legacy.assets ?? []) {
      if (asset.unit === ADA_ASSET.unit || byUnit.has(asset.unit)) continue;
      byUnit.set(asset.unit, { fieldName: asset.ticker, unit: asset.unit, decimals: asset.decimals });
    }
    for (const budget of data?.budgets ?? []) {
      if (budget.unit === ADA_ASSET.unit) continue;
      byUnit.set(budget.unit, { fieldName: budget.assetLabel, unit: budget.unit, decimals: budget.decimals });
    }
    return unitDisplayFromRegistry([ADA_ASSET, ...byUnit.values()]);
  }, [data?.budgets, data?.legacy.assets, registry.data]);
  // Budget owners by id: workgroups (archived ones marked) and treasuries.
  const treasuries = data?.series.treasuries;
  const names = useMemo(() => new Map([
    ...(workgroups.data ?? []).map((workgroup): [string, string] =>
      [workgroup.id, workgroup.archived_at ? `${workgroup.name} (Archived)` : workgroup.name]),
    ...(treasuries ?? []).map((treasury): [string, string] => [treasury.id, budgetOwnerLabel("treasury", treasury.name)]),
  ]), [workgroups.data, treasuries]);
  // Where spend was paid from: the treasuries, then previous wallets whose
  // history was imported. Only the charts use it; previous wallets never own
  // a budget, so the filters and the names map stay on treasuries.
  const legacyWallets = data?.legacy.wallets;
  const spendSources = useMemo(() => [
    ...(treasuries ?? []),
    ...(legacyWallets ?? []).map((wallet) => ({ id: wallet.id, name: legacyWalletLabel(wallet.name) })),
  ], [treasuries, legacyWallets]);

  const model = useMemo(() => {
    if (!data) return null;
    // All time has no period: nothing is shaded, and the flow sums every bucket.
    const period = allTime ? null
      : budgetPeriod(view === "quarter" ? "quarterly" : "monthly", monthDate(month));
    const periodLabel = period?.label ?? "All time";
    const selected = allTime ? [] : view === "quarter" ? quarterMonths(month) : [month];
    const flowMonths = allTime ? data.series.months.map((item) => item.month) : selected;
    const bucket = data.series.bucket;
    const infoFor = (token: string) => display.get(token) ?? { ticker: shortUnit(token), decimals: 0 };
    const mine = <T extends { ownerId: string }>(items: T[]) =>
      workgroupId === ALL_WORKGROUPS ? items : items.filter((item) => item.ownerId === workgroupId);
    const budgets = mine(data.budgets);
    const spending = mine(data.spending);
    const months = monthsForOwner(data.series, workgroupId);
    const tableRows = budgetTableRows({ budgets, spending, refunds: mine(data.refunds), period, view, names, mainUnit });
    return {
      periodLabel,
      bucket,
      tokens: tokenOptions(data.budgets, data.spending, data.series, mainUnit, flowUnits(data.flows.months)),
      contributors: contributorsTasksRows(months, selected, bucket),
      // One chart of each kind per token: the budgeted set, or the filter's token.
      charts: chartUnits(budgets, mainUnit, unit).map((token) => {
        const info = infoFor(token);
        return {
          unit: token,
          ticker: info.ticker,
          treasury: treasurySpendingRows(months, token, info, spendSources, selected, bucket),
          workgroups: workgroupSpendingRows(tableRows, token, info),
          flow: fundingFlowGraph({
            flows: data.flows.months, series: data.series, months: flowMonths, unit: token, info,
            workgroupId, treasuries: spendSources, names, fundingSources: data.fundingSources,
          }),
        };
      }),
      tableRows,
      totals: budgetTableTotals(tableRows, mainUnit),
      // Payouts in a visible budget's own period, or in the view period otherwise.
      spendingList: period === null ? spending : spending.filter((item) =>
        budgets.some((budget) => budget.ownerId === item.ownerId && budget.unit === item.unit &&
          inBudgetPeriod(item.createdAt, budget.periodStart, budget.periodEnd)) ||
        inBudgetPeriod(item.createdAt, period.start, period.end)),
    };
  }, [allTime, data, display, mainUnit, month, names, spendSources, unit, view, workgroupId]);

  if (blocked) return blocked;

  // The worksheet has no all-time view: it opens on the current month.
  const budgetMonth = allTime ? currentBudgetMonth() : month;
  const editHref = routes.budgets(slug, { month: budgetMonth, view: allTime ? "month" : view });
  const conflicts = (data?.setups ?? []).filter((setup) => setup.legacyConflict && !setupAt(setup, budgetMonth));

  return (
    <div>
      <PageTitle action={<LinkButton href={editHref} variant="secondary">Edit budgets</LinkButton>}>
        Dashboard
      </PageTitle>
      <p className="-mt-3 mb-6 max-w-3xl text-sm text-zinc-400">
        Who was paid, what each workgroup and treasury spent against its budget, and what left the treasury.
      </p>
      <Card className="mb-6">
        <DashboardFilters month={month} view={view} workgroupId={workgroupId} unit={unit}
          workgroups={workgroups.data ?? []} treasuries={treasuries ?? []}
          tokens={model?.tokens ?? [LOVELACE]} display={display}
          onPeriod={(nextMonth, nextView) => { setMonth(nextMonth); setView(nextView); }}
          onWorkgroup={setWorkgroupId} onUnit={setUnit} />
      </Card>
      {conflicts.length > 0 && <p role="status" className="mb-6 rounded-xl border border-amber-500/30 p-4 text-sm text-amber-400">
        Some projects have mixed original budget setups and are excluded from budget totals until reviewed:
        {" "}{conflicts.map((setup) => setup.ownerName).join(", ")}.
        Open Edit budgets to review their preserved records.
      </p>}

      {!model && !dashboard.error && <p className="mb-6 text-sm text-zinc-500">Loading spending…</p>}
      {model && <>
        <div className="mb-6 grid gap-6 xl:grid-cols-2">
          <ContributorsTasksChart rows={model.contributors} allTime={allTime} bucket={model.bucket} />
          {model.charts.map((chart) => (
            <TreasurySpendingChart key={chart.unit} rows={chart.treasury.rows} series={chart.treasury.series} ticker={chart.ticker}
              allTime={allTime} bucket={model.bucket} />
          ))}
        </div>
        <div className="mb-6 grid gap-6">
          {model.charts.map((chart) => (
            <FundingFlowChart key={chart.unit} graph={chart.flow} ticker={chart.ticker} periodLabel={model.periodLabel} />
          ))}
        </div>
        <div className="mb-6 grid gap-6 xl:grid-cols-[minmax(0,2fr)_minmax(0,3fr)]">
          <div className="min-w-0 space-y-6 xl:self-start">
            {model.charts.map((chart) => (
              <WorkgroupSpendingChart key={chart.unit} rows={chart.workgroups} ticker={chart.ticker} periodLabel={model.periodLabel} />
            ))}
          </div>
          <BudgetTable rows={model.tableRows} totals={model.totals} display={display} periodLabel={model.periodLabel} editHref={editHref} />
        </div>
        <div className="grid gap-6 xl:grid-cols-[minmax(0,1.6fr)_minmax(20rem,0.7fr)]">
          <SpendingDetailList items={model.spendingList} display={display} loading={dashboard.loading} />
          <IncomingPanel items={data?.incoming ?? []} display={display} loading={dashboard.loading} manageHref={routes.reconcile(slug)} />
        </div>
      </>}

      <ErrorText error={dashboard.error ?? workgroups.error ?? registry.error} className="mt-4" />
    </div>
  );
}
