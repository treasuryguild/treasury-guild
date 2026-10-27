"use client";

import { use, useMemo, useRef, useState } from "react";
import type { BuildPayoutResponse } from "@/lib/api/types";
import { toMemberOptions } from "@/lib/boardTypes";
import { appNetwork, asNetwork } from "@/lib/config";
import { overBudgetFields } from "@/lib/payday/budget";
import { canBuildPayout } from "@/lib/payday/canBuild";
import { deriveMatching } from "@/lib/payday/matching";
import { deriveSelection } from "@/lib/payday/selection";
import { summarizeSelection } from "@/lib/payday/summary";
import type { PayableTask } from "@/lib/payday/types";
import { buildPaydayView, isFiltered, NO_FILTER, readyCountByTreasury } from "@/lib/payday/view";
import { useAssetRegistry } from "@/hooks/useAssetRegistry";
import { useBuildTx } from "@/hooks/useBuildTx";
import { useNetworkGate } from "@/hooks/useNetworkGate";
import { useCommunityGate } from "@/hooks/useCommunityGate";
import { useCommunityMembers } from "@/hooks/useCommunityMembers";
import { useMyTreasuryRoles } from "@/hooks/useMyTreasuryRoles";
import { usePayableTasks } from "@/hooks/usePayableTasks";
import { useTaskSave } from "@/hooks/useTaskSave";
import { useTreasuries } from "@/hooks/useTreasuries";
import { useTreasuryWalletTokens } from "@/hooks/useTreasuryTokenTickers";
import { useWalletAssets } from "@/hooks/useWalletAssets";
import { useCommunityBudgetSetups } from "@/hooks/useWorkgroupBudgetSetups";
import { useWorkgroups } from "@/hooks/useWorkgroups";
import { useWorkgroupTreasuryAssignments } from "@/hooks/useWorkgroupTreasuryAssignments";
import { BusyOverlay, Button, EmptyState, PageTitle } from "@/components/ui";
import { offeredPaths, PathPicker } from "@/components/tx/PathPicker";
import { TxKind, type SpendingPath } from "@/lib/constants";
import { TaskModal } from "@/components/board/TaskModal";
import { ElsewhereSection } from "@/components/payday/ElsewhereSection";
import { PaydayFilters } from "@/components/payday/PaydayFilters";
import { PaydayWorkgroupGroup } from "@/components/payday/PaydayWorkgroupGroup";
import { PayoutSummary, type CoverageTarget } from "@/components/payday/PayoutSummary";
import { TaskRow } from "@/components/payday/TaskRow";
import { TreasuryPicker } from "@/components/payday/TreasuryPicker";
import { managesWorkgroup } from "@/lib/roles";
import { useTreasuryChoice } from "@/hooks/useTreasuryChoice";

const EMPTY_REGISTRY: never[] = [];

export default function PaydayPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const { community, isAdmin, blocked } = useCommunityGate(slug);
  const tasksQuery = usePayableTasks(community?.id);
  const treasuriesQuery = useTreasuries(community?.id);
  const workgroupsQuery = useWorkgroups(community?.id);
  const registryQuery = useAssetRegistry(community?.id);
  const roles = useMyTreasuryRoles(community?.id);
  const { build, busy, error } = useBuildTx(slug);
  const { reason: networkReason } = useNetworkGate(community?.network);

  // In-place task editing (the board's dialog) for admins and workgroup
  // leads. Its inputs are prefetched: the editor decides which stored tickers
  // are "custom" when it mounts, so the ticker list must already be loaded.
  // Tickers come from every community treasury (the superset the board uses
  // for an unrouted workgroup) since Payday tasks span workgroups.
  const canManageAny = isAdmin || roles.ledWorkgroupIds.size > 0;
  const members = useCommunityMembers(canManageAny ? community?.id : null);
  const memberOptions = useMemo(() => toMemberOptions(members.data ?? []), [members.data]);
  const walletTokens = useTreasuryWalletTokens(community?.id, null, canManageAny);
  const tokenTickers = useMemo(() => {
    const byLower = new Map<string, string>();
    for (const t of walletTokens) {
      if (!t.ticker) continue;
      if (!byLower.has(t.ticker.toLowerCase())) byLower.set(t.ticker.toLowerCase(), t.ticker);
    }
    return [...byLower.values()].sort();
  }, [walletTokens]);
  // Setups are also what resolves a task's wallet for its budget period.
  const budgetSetupsByWorkgroup = useCommunityBudgetSetups(community?.id, true);
  const assignmentsByWorkgroup = useWorkgroupTreasuryAssignments(community?.id);
  const routing = useMemo(
    () => ({ assignments: assignmentsByWorkgroup, setups: budgetSetupsByWorkgroup }),
    [assignmentsByWorkgroup, budgetSetupsByWorkgroup],
  );
  const save = useTaskSave(tasksQuery.reload);
  const [editing, setEditing] = useState<PayableTask | null>(null);

  const { treasuryId, setTreasuryId, selectedTreasury } = useTreasuryChoice(treasuriesQuery.data);
  // Only the unticks are state: the selection is every ready task this
  // treasury may pay minus these, so a reload after an edit keeps the choices.
  const [optedOut, setOptedOut] = useState<ReadonlySet<string>>(new Set());
  const [connections, setConnections] = useState<Record<string, string>>({});
  const [filter, setFilter] = useState(NO_FILTER);
  const [showElsewhere, setShowElsewhere] = useState(false);
  const [path, setPath] = useState<SpendingPath | "">("");
  // Fixed at mount: a render must not read the clock.
  const [nowMs] = useState(() => Date.now());
  const listRef = useRef<HTMLDivElement>(null);

  const tasks = useMemo(() => tasksQuery.data ?? [], [tasksQuery.data]);
  const treasuries = treasuriesQuery.data ?? [];
  const registry = registryQuery.data ?? EMPTY_REGISTRY;
  const wallet = useWalletAssets(selectedTreasury?.address).data;

  const selected = useMemo(
    () => deriveSelection(tasks, treasuryId, optedOut, routing),
    [tasks, treasuryId, optedOut, routing],
  );
  const view = useMemo(
    () => buildPaydayView(tasks, { treasuryId, routing, selected, filter }),
    [tasks, treasuryId, routing, selected, filter],
  );
  const readyCounts = useMemo(
    () =>
      tasksQuery.data && treasuriesQuery.data && treasuriesQuery.data.length > 1
        ? readyCountByTreasury(tasksQuery.data, treasuriesQuery.data.map((t) => t.id), routing)
        : undefined,
    [tasksQuery.data, treasuriesQuery.data, routing],
  );

  const summary = useMemo(() => summarizeSelection(tasks, selected), [tasks, selected]);
  const matching = useMemo(
    () => deriveMatching(summary.fields, registry, wallet?.tokens ?? [], connections),
    [summary.fields, registry, wallet, connections],
  );

  if (blocked) return blocked;

  const overBudget = overBudgetFields(summary.totals, wallet ?? null, matching.effective);
  // A lock-until treasury builds nothing before its date; a co-signer
  // treasury offers the co-signed path (default) or the bypass.
  const offered = selectedTreasury ? offeredPaths(selectedTreasury, TxKind.Payout, nowMs) : { paths: [], blocked: null };
  const chosenPath = path && offered.paths.includes(path) ? path : offered.paths[0];
  const canBuild = !!chosenPath && canBuildPayout({
    treasuryId,
    signerTreasuryIds: roles.signerTreasuryIds,
    ledWorkgroupIds: roles.ledWorkgroupIds,
    selectedWorkgroupIds: summary.selectedWorkgroupIds,
  });

  function setChecked(taskIds: string[], checked: boolean) {
    setOptedOut((prev) => {
      const next = new Set(prev);
      for (const id of taskIds) {
        if (checked) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  }

  // Manual token connections belong to the wallet they were made for.
  function chooseTreasury(id: string) {
    setTreasuryId(id);
    setConnections({});
  }

  const scrollToList = () => listRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });

  function show(target: CoverageTarget) {
    setFilter(target === "attention" || target === "unticked" ? { ...NO_FILTER, status: target } : NO_FILTER);
    if (target === "elsewhere") setShowElsewhere(true);
    else scrollToList();
  }

  function payFrom(id: string) {
    chooseTreasury(id);
    setShowElsewhere(false);
    scrollToList();
  }

  function renderRow(t: PayableTask, lockedByName: string | null = null) {
    return (
      <TaskRow
        key={t.id}
        task={t}
        selected={!lockedByName && selected.has(t.id)}
        lockedByName={lockedByName}
        onToggle={(checked) => setChecked([t.id], checked)}
        onEdit={managesWorkgroup({ isAdmin, ...roles }, t.workgroup_id) ? () => setEditing(t) : undefined}
      />
    );
  }

  return (
    <div>
      <PageTitle>Payday</PageTitle>

      <TreasuryPicker
        treasuries={treasuries}
        workgroups={workgroupsQuery.data ?? []}
        value={treasuryId}
        onChange={chooseTreasury}
        wallet={wallet ?? null}
        readyCounts={readyCounts}
      />

      <PathPicker treasury={selectedTreasury} kind={TxKind.Payout} value={chosenPath ?? ""} onChange={setPath} disabled={busy} nowMs={nowMs} />

      <div ref={listRef} className="mb-6 scroll-mt-4">
        {!tasksQuery.loading && tasks.length === 0 && (
          <EmptyState>
            No payable tasks. Tasks become payable when they get the audited
            label (GitHub) or are moved to a payable column (native boards).
          </EmptyState>
        )}
        {tasks.length > 0 && (
          <PaydayFilters
            filter={filter}
            counts={view.counts}
            workgroups={view.workgroups}
            onChange={setFilter}
          />
        )}
        {tasks.length > 0 && view.groups.length === 0 && (
          isFiltered(filter) ? (
            <EmptyState action={<Button variant="secondary" onClick={() => setFilter(NO_FILTER)}>Show all</Button>}>
              No tasks match these filters.
            </EmptyState>
          ) : (
            <EmptyState>
              No payable tasks for this treasury. The tasks below are paid from
              other treasuries.
            </EmptyState>
          )
        )}
        <div className="space-y-4">
          {view.groups.map((g) => (
            <PaydayWorkgroupGroup
              key={g.workgroupId}
              group={g}
              selected={selected}
              onSetSelected={setChecked}
              renderRow={(t) => renderRow(t)}
            />
          ))}
        </div>
        <ElsewhereSection
          elsewhere={view.elsewhere}
          total={view.elsewhereCount}
          treasuries={treasuries}
          open={showElsewhere}
          onOpenChange={setShowElsewhere}
          onPayFrom={payFrom}
          renderRow={renderRow}
        />
      </div>

      {editing && (
        <TaskModal
          task={editing}
          members={memberOptions}
          tokenTickers={tokenTickers}
          walletTokens={walletTokens}
          network={community ? asNetwork(community.network) : appNetwork()}
          budgetSetups={budgetSetupsByWorkgroup.get(editing.workgroup_id) ?? []}
          busy={save.busy}
          saveError={save.error}
          onClose={() => setEditing(null)}
          onSave={(fields) =>
            void save.saveTask(editing, fields).then((ok) => ok && setEditing(null))
          }
        />
      )}

      <BusyOverlay
        open={busy}
        title="Building payout transaction…"
        hint="Fetching treasury UTxOs and balancing the transaction. Keep this tab open."
      />

      {summary.count > 0 && (
        <PayoutSummary
          summary={summary}
          matching={matching}
          wallet={wallet ?? null}
          treasuryId={treasuryId}
          connections={connections}
          onConnectionsChange={setConnections}
          overBudgetFields={overBudget}
          canBuild={canBuild}
          busy={busy}
          error={error}
          blockedReason={networkReason}
          coverage={{
            attention: view.counts.attention,
            unticked: view.counts.unticked,
            elsewhere: view.elsewhereCount,
            hiddenSelected: view.hiddenSelected,
          }}
          onShow={show}
          onBuild={() =>
            void build<BuildPayoutResponse>("/api/tx/build-payout", {
              treasuryId,
              path: chosenPath,
              taskIds: [...selected],
              connections,
            })
          }
        />
      )}
    </div>
  );
}
