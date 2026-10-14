"use client";

// Funding sources: outside funders, what they committed and what has arrived
// so far. Members read it; admins add sources and commitments. Inflows are
// tied to a source on the Incoming page.
import { use, useMemo, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { OkResponse } from "@/lib/api/types";
import type { FundingCommitmentKind, FundingCommitmentRow, FundingSourceRow } from "@/lib/db/types";
import { fundingTokenOptions } from "@/lib/funding/display";
import { sourceSummary, type FundingInflow } from "@/lib/funding/plan";
import { useAssetRegistry } from "@/hooks/useAssetRegistry";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useCommunityGate } from "@/hooks/useCommunityGate";
import { useFunding } from "@/hooks/useFunding";
import { useTreasuries } from "@/hooks/useTreasuries";
import { useWalletAssetsMany } from "@/hooks/useWalletAssets";
import { CommitmentDialog } from "@/components/funding/CommitmentDialog";
import { FundingSourceCard } from "@/components/funding/FundingSourceCard";
import { FundingSourceDialog } from "@/components/funding/FundingSourceDialog";
import { ScheduleEditor } from "@/components/funding/ScheduleEditor";
import { Button, ConfirmDialog, EmptyState, ErrorText, Field, Input, Modal, PageTitle } from "@/components/ui";

type Dialog =
  | { type: "source"; source?: FundingSourceRow }
  | { type: "deleteSource"; source: FundingSourceRow }
  | { type: "commitment"; sourceId: string; commitment?: FundingCommitmentRow; kind?: FundingCommitmentKind }
  | { type: "deleteCommitment"; commitment: FundingCommitmentRow }
  | { type: "schedule"; commitmentId: string };

export default function FundingPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const { community, isAdmin, blocked } = useCommunityGate(slug);
  const treasuries = useTreasuries(community?.id);
  const treasuryIds = useMemo(() => (treasuries.data ?? []).map((t) => t.id), [treasuries.data]);
  const funding = useFunding(community?.id, treasuryIds);
  const registry = useAssetRegistry(community?.id);
  const wallets = useWalletAssetsMany(isAdmin ? (treasuries.data ?? []).map((t) => t.address) : []);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const [confirmName, setConfirmName] = useState("");
  const remove = useAsyncAction("Failed to delete");

  const data = funding.data;
  const options = useMemo(() => fundingTokenOptions(
    registry.data ?? [],
    Object.values(wallets.data ?? {}).flatMap((w) => w.tokens.map((t) => ({ unit: t.unit, ticker: t.ticker, decimals: t.decimals }))),
    data?.commitments ?? [],
    data?.periods ?? [],
  ), [registry.data, wallets.data, data]);
  const inflows: FundingInflow[] = useMemo(() => (data?.inflows ?? []).map((row) => ({
    txHash: row.tx_hash,
    blockTime: row.block_time,
    sourceId: row.funding_source_id!,
    commitmentId: row.funding_commitment_id,
    amountLovelace: row.amount_lovelace,
    assets: row.assets,
  })), [data]);

  if (blocked) return blocked;

  const now = new Date();
  const treasuryName = (id: string) => (treasuries.data ?? []).find((t) => t.id === id)?.name ?? "Treasury";
  const close = () => { setDialog(null); setConfirmName(""); remove.setError(null); };
  const saved = () => { close(); funding.reload(); };

  async function deleteSource(source: FundingSourceRow) {
    const ok = await remove.run(() => apiFetch<OkResponse>(`/api/funding/sources/${source.id}`, { method: "DELETE", body: { confirmName } }));
    if (ok) saved();
  }
  async function deleteCommitment(commitment: FundingCommitmentRow) {
    const ok = await remove.run(() => apiFetch<OkResponse>(`/api/funding/commitments/${commitment.id}`, { method: "DELETE" }));
    if (ok) saved();
  }
  function commitmentSaved(createdId: string | null, kind: FundingCommitmentKind) {
    funding.reload();
    // A new schedule has no periods yet: load them straight away.
    setDialog(createdId && kind === "schedule" ? { type: "schedule", commitmentId: createdId } : null);
  }

  const scheduleCommitment = dialog?.type === "schedule"
    ? data?.commitments.find((c) => c.id === dialog.commitmentId)
    : undefined;

  return (
    <div className="space-y-6">
      <PageTitle action={isAdmin ? <Button onClick={() => setDialog({ type: "source" })}>Add funding source</Button> : undefined}>
        Funding sources
      </PageTitle>
      <p className="-mt-3 max-w-3xl text-sm text-zinc-400">
        Track what outside funders committed, such as a treasury that releases a monthly allocation or Project Catalyst
        proposals, against what actually arrived in your treasuries. Tie an inflow to a source with <strong>Details</strong> on
        the Incoming page.
      </p>
      <ErrorText error={funding.error ?? treasuries.error} />
      {data && data.sources.length === 0 && (
        <EmptyState>No funding sources yet.{isAdmin ? " Add the first one to start tracking what was promised." : ""}</EmptyState>
      )}
      {data?.sources.map((source) => (
        <FundingSourceCard
          key={source.id}
          slug={slug}
          source={source}
          summary={sourceSummary(source.id, data.commitments, data.periods, inflows, now)}
          commitments={data.commitments.filter((c) => c.source_id === source.id)}
          periods={data.periods}
          inflows={data.inflows}
          options={options}
          treasuryName={treasuryName}
          isAdmin={isAdmin}
          onEdit={() => setDialog({ type: "source", source })}
          onDelete={() => setDialog({ type: "deleteSource", source })}
          onAddCommitment={() => setDialog({ type: "commitment", sourceId: source.id })}
          onImportCsv={() => setDialog({ type: "commitment", sourceId: source.id, kind: "schedule" })}
          onEditCommitment={(commitment) => setDialog({ type: "commitment", sourceId: source.id, commitment })}
          onDeleteCommitment={(commitment) => setDialog({ type: "deleteCommitment", commitment })}
          onEditSchedule={(commitment) => setDialog({ type: "schedule", commitmentId: commitment.id })}
        />
      ))}

      {community && dialog?.type === "source" && (
        <FundingSourceDialog communityId={community.id} source={dialog.source} onClose={close} onSaved={saved} />
      )}
      {dialog?.type === "commitment" && (
        <CommitmentDialog sourceId={dialog.sourceId} commitment={dialog.commitment} initialKind={dialog.kind} options={options}
          onClose={close} onSaved={commitmentSaved} />
      )}
      {dialog?.type === "schedule" && scheduleCommitment && data && (
        <ScheduleEditor commitment={scheduleCommitment} periods={data.periods} options={options} onClose={close} onSaved={saved} />
      )}
      <ConfirmDialog open={dialog?.type === "deleteCommitment"} title="Remove this commitment?" confirmLabel="Remove"
        busy={remove.busy} error={remove.error} onCancel={close}
        onConfirm={() => { if (dialog?.type === "deleteCommitment") void deleteCommitment(dialog.commitment); }}>
        Inflows tied to it stay tied to the funding source, as received without a commitment.
      </ConfirmDialog>
      <Modal open={dialog?.type === "deleteSource"} onClose={close} busy={remove.busy} title="Delete funding source">
        {dialog?.type === "deleteSource" && (
          <div className="space-y-4">
            <p className="text-sm text-zinc-400">
              This removes the source and its commitments. Inflows tied to it stay in your treasuries and are only untied.
            </p>
            <Field label={`Type “${dialog.source.name}” to confirm`}>
              <Input aria-label="Confirm funding source name" value={confirmName} onChange={(e) => setConfirmName(e.target.value)} />
            </Field>
            <ErrorText error={remove.error} />
            <div className="flex justify-end gap-2">
              <Button variant="secondary" onClick={close} disabled={remove.busy}>Cancel</Button>
              <Button variant="danger" loading={remove.busy} disabled={confirmName.trim() !== dialog.source.name}
                onClick={() => void deleteSource(dialog.source)}>Delete source</Button>
            </div>
          </div>
        )}
      </Modal>
    </div>
  );
}
