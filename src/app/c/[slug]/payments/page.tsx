"use client";

// Manual payments from a treasury. A "Fund this budget" link from an applied
// budget proposal prefills the form through the query string (?to=&month=
// &proposal=&amounts=): one transfer to the receiving treasury with the
// period's voted amounts, citing the proposal; the paying treasury is picked here.
import Link from "next/link";
import { use, useEffect, useMemo, useRef, useState } from "react";
import { Plus } from "lucide-react";
import { apiFetch } from "@/lib/api/client";
import type { BudgetsResponse, BuildPaymentResponse } from "@/lib/api/types";
import { toMemberOptions } from "@/lib/boardTypes";
import { currentBudgetMonth } from "@/lib/budgets";
import { taskBudgetPeriod } from "@/lib/budgetSetups";
import { asNetwork } from "@/lib/config";
import {
  budgetLines, drainAmounts, draftProblems, draftToRequest, draftTotals, newRecipient, overBalance, walletTokens,
  type RecipientDraft,
} from "@/lib/payments/form";
import { parsePaymentPrefill } from "@/lib/payments/prefill";
import { routes } from "@/lib/routes";
import { useAsyncData } from "@/hooks/useAsyncData";
import { useBuildTx } from "@/hooks/useBuildTx";
import { useCommunityGate } from "@/hooks/useCommunityGate";
import { useCommunityMembers } from "@/hooks/useCommunityMembers";
import { useMyTreasuryRoles } from "@/hooks/useMyTreasuryRoles";
import { useNetworkGate } from "@/hooks/useNetworkGate";
import { activeTreasuries, useTreasuries } from "@/hooks/useTreasuries";
import { useWalletAssets } from "@/hooks/useWalletAssets";
import { useTreasuryBudgetSetups } from "@/hooks/useWorkgroupBudgetSetups";
import { useWorkgroups } from "@/hooks/useWorkgroups";
import { PaymentSummary } from "@/components/payments/PaymentSummary";
import { PeriodField } from "@/components/payments/PeriodField";
import { RecipientRow } from "@/components/payments/RecipientRow";
import { TreasuryPicker } from "@/components/payday/TreasuryPicker";
import { BusyOverlay, Button, NoticeText, PageTitle, WarningText } from "@/components/ui";
import { actsForTreasury, mayRecover } from "@/lib/roles";
import { SpendingPath, TxKind } from "@/lib/constants";
import { offeredPaths, PathPicker } from "@/components/tx/PathPicker";
import { useTreasuryChoice } from "@/hooks/useTreasuryChoice";

export default function PaymentsPage({ params, searchParams }: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const { slug } = use(params);
  const query = use(searchParams);
  const prefill = useMemo(() => parsePaymentPrefill(query), [query]);
  const { community, blocked } = useCommunityGate(slug);
  const treasuriesQuery = useTreasuries(community?.id);
  const workgroupsQuery = useWorkgroups(community?.id);
  const members = useCommunityMembers(community?.id);
  const roles = useMyTreasuryRoles(community?.id);
  const { build, busy, error } = useBuildTx(slug);
  const { reason: networkReason } = useNetworkGate(community?.network);

  const pickable = useMemo(
    () => (treasuriesQuery.data ? activeTreasuries(treasuriesQuery.data) : undefined),
    [treasuriesQuery.data],
  );
  const { treasuryId, setTreasuryId, selectedTreasury } = useTreasuryChoice(pickable);
  const [rows, setRows] = useState<RecipientDraft[]>([newRecipient(0)]);
  const [nextKey, setNextKey] = useState(1);
  const [drain, setDrain] = useState(false);
  const [month, setMonth] = useState(prefill?.month ?? currentBudgetMonth());
  const [memo, setMemo] = useState("");
  const [path, setPath] = useState<SpendingPath | "">("");
  // Fixed at mount: a render must not read the clock.
  const [nowMs] = useState(() => Date.now());

  const allTreasuries = useMemo(() => treasuriesQuery.data ?? [], [treasuriesQuery.data]);
  const treasuries = useMemo(() => pickable ?? [], [pickable]);
  const wallet = useWalletAssets(selectedTreasury?.address).data ?? null;
  const setups = useTreasuryBudgetSetups(treasuryId || null);
  const memberOptions = useMemo(() => toMemberOptions(members.data ?? []), [members.data]);
  const siblings = useMemo(() => treasuries.filter((t) => t.id !== treasuryId), [treasuries, treasuryId]);
  const tokens = useMemo(() => walletTokens(wallet), [wallet]);

  // The prefilled transfer, once the treasuries are known: one row to the
  // receiving treasury with the voted amounts. Applied once; edits stay.
  const receiving = prefill ? allTreasuries.find((t) => t.id === prefill.treasuryId) ?? null : null;
  const receivingActive = receiving && !receiving.archived_at ? receiving : null;
  const prefilled = useRef(false);
  useEffect(() => {
    if (!prefill || !receivingActive || prefilled.current) return;
    prefilled.current = true;
    setRows([{ key: 0, kind: "treasury", address: receivingActive.address, amounts: { ...prefill.amounts } }]);
  }, [prefill, receivingActive]);

  // The treasury's budgets for the period the payment counts against.
  const period = taskBudgetPeriod(`${month}-01`, setups, currentBudgetMonth());
  const budgetsQuery = useAsyncData(
    community && treasuryId ? `${community.id}:${treasuryId}:${period.month}` : null,
    () => apiFetch<BudgetsResponse>("/api/budgets", { query: { communityId: community!.id, month: period.month, view: "month" } }),
  );

  const model = useMemo(() => {
    const totals = draftTotals(rows, tokens);
    const siblingAddresses = new Set(siblings.map((t) => t.address));
    const transferRows = rows.filter((row) => siblingAddresses.has(row.address.trim()));
    const spendTotals = draftTotals(rows.filter((row) => !siblingAddresses.has(row.address.trim())), tokens);
    return {
      totals,
      transfers: transferRows.length,
      over: overBalance(totals, tokens),
      problems: selectedTreasury && community
        ? draftProblems(rows, tokens, {
          treasuryAddress: selectedTreasury.address, network: asNetwork(community.network), drain,
        })
        : [],
      budgets: budgetLines(budgetsQuery.data?.budgets ?? [], treasuryId, spendTotals),
    };
  }, [rows, tokens, siblings, selectedTreasury, community, budgetsQuery.data, treasuryId, drain]);

  if (blocked) return blocked;

  // The path the build takes: the treasury's default unless one was picked.
  // Recovery path: recovery signers only; every other path: base signers.
  const offered = selectedTreasury ? offeredPaths(selectedTreasury, TxKind.Payment, nowMs) : { paths: [], blocked: null };
  const chosenPath = path && offered.paths.includes(path) ? path : offered.paths[0];
  const canBuild = !!treasuryId && !!chosenPath && (
    chosenPath === SpendingPath.Recovery
      ? mayRecover(roles, treasuryId)
      : actsForTreasury(roles, treasuryId)
  );

  function updateRow(key: number, patch: Partial<RecipientDraft>) {
    setRows((list) => list.map((row) => (row.key === key ? { ...row, ...patch } : row)));
  }

  function startDrain(key: number) {
    setRows((list) => {
      const row = list.find((r) => r.key === key);
      if (!row) return list;
      return [{ ...row, amounts: drainAmounts(tokens) }];
    });
    setDrain(true);
  }

  function clearDrain() {
    setDrain(false);
  }

  return (
    <div>
      <PageTitle>Payments</PageTitle>
      <p className="-mt-3 mb-6 max-w-3xl text-sm text-zinc-400">
        Pay outside addresses, community members or another of your treasuries in one transaction.
        Payments count against the paying treasury&apos;s own budget; transfers between your treasuries never do.
      </p>

      {prefill && receivingActive && (
        <NoticeText className="mb-4">
          Funding the {period.code} budget voted in{" "}
          <Link className="underline" href={routes.proposal(slug, prefill.proposalId)}>this proposal</Link>: a transfer to{" "}
          {receivingActive.name} with the voted amounts, cited on-chain. Pick the treasury that pays; the amounts can be edited.
        </NoticeText>
      )}
      {prefill && treasuriesQuery.data && !receiving && (
        <WarningText className="mb-4">The treasury this link would fund is not one of this community&apos;s; nothing was filled in.</WarningText>
      )}
      {prefill && receiving?.archived_at && (
        <WarningText className="mb-4">Restore {receiving.name} before transferring to it.</WarningText>
      )}
      {prefill && receivingActive && treasuryId === receivingActive.id && (
        <WarningText className="mb-4">Pick a treasury other than {receivingActive.name}: it is the one being funded.</WarningText>
      )}

      <TreasuryPicker
        treasuries={treasuries}
        workgroups={workgroupsQuery.data ?? []}
        value={treasuryId}
        onChange={(id) => {
          setTreasuryId(id);
          setDrain(false);
        }}
        wallet={wallet}
      />

      <PathPicker treasury={selectedTreasury} kind={TxKind.Payment} value={chosenPath ?? ""} onChange={setPath} disabled={busy} nowMs={nowMs} />

      <div className="mb-6 space-y-3">
        {rows.map((row, index) => (
          <RecipientRow key={row.key} row={row} index={index} members={memberOptions} treasuries={siblings}
            tokens={tokens} disabled={busy || !treasuryId} drain={drain}
            canDrain={!!row.address.trim() && tokens.some((t) => t.held > 0n)}
            onChange={(patch) => updateRow(row.key, patch)}
            onDrain={() => startDrain(row.key)}
            onClearDrain={clearDrain}
            onRemove={rows.length > 1 && !drain ? () => setRows((list) => list.filter((r) => r.key !== row.key)) : undefined} />
        ))}
        {!drain && (
          <Button variant="secondary" disabled={busy || !treasuryId} onClick={() => {
            setRows((list) => [...list, newRecipient(nextKey)]);
            setNextKey((k) => k + 1);
          }}>
            <Plus className="h-4 w-4" />Add recipient
          </Button>
        )}
      </div>

      <div className="mb-6">
        <PeriodField month={month} setups={setups} disabled={busy} onChange={setMonth} />
      </div>

      <BusyOverlay
        open={busy}
        title="Building payment transaction…"
        hint="Fetching treasury UTxOs and balancing the transaction. Keep this tab open."
      />

      <PaymentSummary
        recipients={rows.filter((row) => row.address.trim()).length}
        transfers={model.transfers}
        totals={model.totals}
        tokens={tokens}
        overBalance={drain ? [] : model.over}
        budgets={model.budgets}
        budgetsLoading={budgetsQuery.loading}
        problems={model.problems}
        drain={drain}
        memo={memo}
        onMemoChange={setMemo}
        canBuild={canBuild}
        busy={busy}
        error={error ?? budgetsQuery.error ?? treasuriesQuery.error ?? members.error}
        blockedReason={networkReason}
        onBuild={() =>
          void build<BuildPaymentResponse>("/api/tx/build-payment", {
            treasuryId, path: chosenPath, budgetMonth: month, memo: memo.trim() || undefined, recipients: draftToRequest(rows),
            ...(drain ? { drain: true } : {}),
            ...(prefill && receiving ? { proposalId: prefill.proposalId } : {}),
          })
        }
      />
    </div>
  );
}
