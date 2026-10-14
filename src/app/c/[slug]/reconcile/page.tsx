"use client";

import { use, useState } from "react";
import { ArrowDownLeft, FilePenLine, Link2 } from "lucide-react";
import { apiFetch } from "@/lib/api/client";
import type { MatchSuggestionsResponse } from "@/lib/api/types";
import { formatUnitAmount, unitDisplayFromRegistry } from "@/lib/assetRegistry";
import { LOVELACE } from "@/lib/assets";
import type { FundingCommitmentRow, FundingSourceRow, IncomingTxRow } from "@/lib/db/types";
import { formatDate, shortAddress, shortHash } from "@/lib/format";
import { browserClient } from "@/lib/supabase/browser";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useAsyncData } from "@/hooks/useAsyncData";
import { useAssetRegistry } from "@/hooks/useAssetRegistry";
import { useChainSync } from "@/hooks/useChainSync";
import { useCommunityGate } from "@/hooks/useCommunityGate";
import { useFunding } from "@/hooks/useFunding";
import { useMyTreasuryRoles } from "@/hooks/useMyTreasuryRoles";
import { useTreasuries } from "@/hooks/useTreasuries";
import { Badge, Button, Card, EmptyState, ErrorText, Field, Input, InsetRow, PageTitle, Select, Textarea } from "@/components/ui";
import { ChainSyncStatus } from "@/components/treasury/ChainSyncStatus";

const INCOMING_LIMIT = 50;
type IncomingType = IncomingTxRow["incoming_type"];

const INCOMING_LABELS: Record<IncomingType, string> = {
  unclassified: "Unclassified",
  refund: "Refund",
  contribution: "Contribution",
  revenue: "Revenue",
  transfer: "Internal transfer",
  other: "Other",
};

function IncomingDetailsForm({ tx, sources, commitments, onSaved }: {
  tx: IncomingTxRow;
  sources: FundingSourceRow[];
  commitments: FundingCommitmentRow[];
  onSaved: () => void;
}) {
  const [incomingType, setIncomingType] = useState<IncomingType>(tx.incoming_type);
  const [requiresReconciliation, setRequiresReconciliation] = useState(tx.requires_reconciliation);
  const [note, setNote] = useState(tx.note ?? "");
  const [fundingSourceId, setFundingSourceId] = useState(tx.funding_source_id ?? "");
  const [fundingCommitmentId, setFundingCommitmentId] = useState(tx.funding_commitment_id ?? "");
  const save = useAsyncAction("Failed to save incoming details");
  // Money from another of the community's treasuries is a transfer, never funding.
  const canFund = !tx.from_treasury_id && sources.length > 0;
  const sourceCommitments = commitments.filter((c) => c.source_id === fundingSourceId);

  async function submit() {
    const result = await save.run(() => apiFetch("/api/reconcile/incoming", {
      method: "PATCH",
      body: {
        txHash: tx.tx_hash, incomingType, requiresReconciliation, note,
        ...(canFund && { fundingSourceId: fundingSourceId || null, fundingCommitmentId: fundingSourceId ? fundingCommitmentId || null : null }),
      },
    }));
    if (result) onSaved();
  }

  return (
    <div className="mt-4 border-t border-zinc-800 pt-4">
      <div className="grid gap-3 md:grid-cols-2">
        <Field label="Incoming type"><Select value={incomingType} onChange={(event) => setIncomingType(event.target.value as IncomingType)}>{Object.entries(INCOMING_LABELS).map(([value, label]) => <option key={value} value={value}>{label}</option>)}</Select></Field>
        <Field label="Reconciliation"><Select value={requiresReconciliation ? "required" : "not-required"} onChange={(event) => setRequiresReconciliation(event.target.value === "required")}><option value="required">Needs reconciliation</option><option value="not-required">No reconciliation needed</option></Select></Field>
      </div>
      {canFund && (
        <div className="mt-3 grid gap-3 md:grid-cols-2">
          <Field label="Funding source" hint="Count this whole inflow as received from an outside funder.">
            <Select aria-label="Funding source" value={fundingSourceId}
              onChange={(event) => { setFundingSourceId(event.target.value); setFundingCommitmentId(""); }}>
              <option value="">None</option>
              {sources.map((source) => <option key={source.id} value={source.id}>{source.name}</option>)}
            </Select>
          </Field>
          {fundingSourceId && (
            <Field label="Commitment (optional)">
              <Select aria-label="Funding commitment" value={fundingCommitmentId} onChange={(event) => setFundingCommitmentId(event.target.value)}>
                <option value="">Not a specific commitment</option>
                {sourceCommitments.map((commitment) => <option key={commitment.id} value={commitment.id}>{commitment.name}</option>)}
              </Select>
            </Field>
          )}
        </div>
      )}
      <Field label="Internal note" className="mt-3" hint="Add context that will help the next admin understand this inflow."><Textarea value={note} onChange={(event) => setNote(event.target.value)} placeholder="e.g. September membership contribution" /></Field>
      <div className="mt-3 flex justify-end"><Button loading={save.busy} onClick={() => void submit()}>{save.busy ? "Saving…" : "Save details"}</Button></div>
      <ErrorText error={save.error} className="mt-2" />
    </div>
  );
}

export default function ReconcilePage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const { community, isAdmin, blocked } = useCommunityGate(slug);
  const treasuries = useTreasuries(community?.id);
  const roles = useMyTreasuryRoles(community?.id);
  const treasuryIds = (treasuries.data ?? []).map((treasury) => treasury.id);
  const incoming = useAsyncData(treasuryIds.length > 0 ? treasuryIds.join(",") : null, async () => {
    const { data, error } = await browserClient().from("incoming_txs").select("*").in("treasury_id", treasuryIds).order("block_time", { ascending: false }).limit(INCOMING_LIMIT);
    if (error) throw error;
    return (data ?? []) as IncomingTxRow[];
  });
  // Background chain poll on visit (two-minute staleness); reloads the list if anything was polled.
  const sync = useChainSync(community?.id, incoming.reload);
  const registry = useAssetRegistry(community?.id);
  const funding = useFunding(community?.id, []);
  const [matchOpen, setMatchOpen] = useState<string | null>(null);
  const [detailsOpen, setDetailsOpen] = useState<string | null>(null);
  const [filter, setFilter] = useState<"all" | "review" | "complete">("all");
  const [note, setNote] = useState("");
  const suggestions = useAsyncData(matchOpen, () => apiFetch<MatchSuggestionsResponse>("/api/reconcile/match", { query: { txHash: matchOpen } }));
  const match = useAsyncAction("Failed to record the match");

  if (blocked) return blocked;

  const display = unitDisplayFromRegistry(registry.data ?? []);
  const assetLabel = (unit: string, amount: string) => formatUnitAmount(unit, amount, display);

  async function confirmMatch(tx: IncomingTxRow, payoutId: string | null, unit = LOVELACE, amount?: string) {
    const ok = await match.run(() => apiFetch("/api/reconcile/match", { body: { txHash: tx.tx_hash, payoutId, amount: amount ?? (unit === LOVELACE ? tx.amount_lovelace : (tx.assets?.[unit] ?? "0")), unit, note } }));
    if (!ok) return;
    setMatchOpen(null);
    setNote("");
    incoming.reload();
  }

  const list = (incoming.data ?? []).filter((tx) => {
    const complete = tx.matched || !tx.requires_reconciliation;
    return filter === "all" || (filter === "complete" ? complete : !complete);
  });

  return (
    <div>
      <PageTitle action={<Select value={filter} onChange={(event) => setFilter(event.target.value as typeof filter)} aria-label="Filter incoming transactions"><option value="all">All incoming</option><option value="review">Needs review</option><option value="complete">Completed</option></Select>}>Incoming & reconciliation</PageTitle>
      <p className="-mt-3 mb-2 max-w-3xl text-sm text-zinc-400">Classify treasury inflows, tie them to a funding source, add internal context, and reconcile refunds against past payouts when needed.</p>
      <ChainSyncStatus {...sync} className="mb-6" />

      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <Card><p className="text-xs text-zinc-500">Incoming</p><p className="mt-1 text-2xl font-semibold">{(incoming.data ?? []).length}</p></Card>
        <Card><p className="text-xs text-zinc-500">Needs review</p><p className="mt-1 text-2xl font-semibold">{(incoming.data ?? []).filter((tx) => tx.requires_reconciliation && !tx.matched).length}</p></Card>
        <Card><p className="text-xs text-zinc-500">Completed</p><p className="mt-1 text-2xl font-semibold">{(incoming.data ?? []).filter((tx) => tx.matched || !tx.requires_reconciliation).length}</p></Card>
      </div>

      <div className="space-y-3">
        {!incoming.loading && list.length === 0 && <EmptyState>No incoming transactions in this view.</EmptyState>}
        {list.map((tx) => {
          const canReconcile = roles.signerTreasuryIds.has(tx.treasury_id);
          const treasuryName = (treasuries.data ?? []).find((treasury) => treasury.id === tx.treasury_id)?.name ?? "Treasury";
          // An inflow from another of the community's wallets names it instead of the address.
          const fromTreasury = tx.from_treasury_id
            ? ((treasuries.data ?? []).find((treasury) => treasury.id === tx.from_treasury_id)?.name ?? "another community wallet")
            : null;
          const status = !tx.requires_reconciliation ? "logged" : tx.matched ? "reconciled" : "needs review";
          return (
            <Card key={tx.tx_hash}>
              <div className="flex flex-col items-start justify-between gap-4 lg:flex-row lg:items-center">
                <div className="min-w-0">
                  <div className="flex flex-wrap items-center gap-2"><span className="grid h-8 w-8 place-items-center rounded-lg bg-emerald-500/10 text-emerald-400"><ArrowDownLeft className="h-4 w-4" /></span><p className="text-base font-semibold">{assetLabel(LOVELACE, tx.amount_lovelace)}</p>{Object.entries(tx.assets ?? {}).map(([unit, qty]) => <Badge key={unit}>{assetLabel(unit, qty)}</Badge>)}</div>
                  <p className="mt-2 font-mono text-xs text-zinc-400">{shortHash(tx.tx_hash)}</p>
                  <p className="mt-1 text-xs text-zinc-500">{treasuryName} · from {fromTreasury ?? (tx.from_addresses[0] ? shortAddress(tx.from_addresses[0]) : "unknown")}{tx.block_time ? ` · ${formatDate(tx.block_time, "datetime")}` : ""}</p>
                  {tx.note && <p className="mt-2 text-sm text-zinc-400">{tx.note}</p>}
                </div>
                <div className="flex w-full flex-wrap items-center gap-2 lg:w-auto lg:justify-end">
                  <Badge>{INCOMING_LABELS[tx.incoming_type]}</Badge>
                  {tx.funding_source_id && (
                    <Badge tone="blue">
                      {(funding.data?.sources ?? []).find((source) => source.id === tx.funding_source_id)?.name ?? "Funding source"}
                      {tx.funding_commitment_id && ` · ${(funding.data?.commitments ?? []).find((c) => c.id === tx.funding_commitment_id)?.name ?? "commitment"}`}
                    </Badge>
                  )}<Badge tone={status === "needs review" ? "yellow" : "green"}>{status}</Badge>
                  {isAdmin && <Button variant="secondary" onClick={() => setDetailsOpen(detailsOpen === tx.tx_hash ? null : tx.tx_hash)}><FilePenLine className="mr-2 h-4 w-4" />Details</Button>}
                  {canReconcile && tx.requires_reconciliation && !tx.matched && <Button onClick={() => setMatchOpen(matchOpen === tx.tx_hash ? null : tx.tx_hash)}><Link2 className="mr-2 h-4 w-4" />Reconcile</Button>}
                </div>
              </div>

              {detailsOpen === tx.tx_hash && <IncomingDetailsForm tx={tx} sources={funding.data?.sources ?? []}
                commitments={funding.data?.commitments ?? []} onSaved={() => { setDetailsOpen(null); incoming.reload(); }} />}
              {matchOpen === tx.tx_hash && (
                <div className="mt-4 border-t border-zinc-800 pt-4">
                  <h4 className="mb-2 text-sm font-medium text-zinc-300">Suggested payouts</h4>
                  {!suggestions.loading && (suggestions.data?.suggestions ?? []).length === 0 && <p className="text-sm text-zinc-500">No matching payouts found.</p>}
                  <div className="space-y-2">{(suggestions.data?.suggestions ?? []).map((suggestion) => <InsetRow key={suggestion.payoutId} className="gap-3"><div><p className="text-sm">{suggestion.taskTitle}</p><p className="text-xs text-zinc-500">{shortAddress(suggestion.contributorWallet)} · {assetLabel(suggestion.unit, suggestion.amount)} paid</p></div><Button disabled={match.busy} onClick={() => void confirmMatch(tx, suggestion.payoutId, suggestion.unit)}>Link refund</Button></InsetRow>)}</div>
                  <div className="mt-3 flex flex-col gap-2 sm:flex-row"><Input value={note} onChange={(event) => setNote(event.target.value)} placeholder="Reconciliation note (optional)" /><Button variant="secondary" disabled={match.busy} onClick={() => void confirmMatch(tx, null)}>Record without payout</Button></div>
                  <ErrorText error={match.error ?? suggestions.error} className="mt-2" />
                </div>
              )}
            </Card>
          );
        })}
      </div>
      <ErrorText error={incoming.error ?? registry.error} className="mt-4" />
    </div>
  );
}
