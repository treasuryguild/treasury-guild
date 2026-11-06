"use client";

// Previous-wallet history: payments (outflows) and receipts (inflows) from
// CSVs the community audited itself. Treasury Guild never reads the old wallet.
import { use, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { LegacyReceiptUploadBody, LegacyUploadBody, LegacyWorkgroupBody } from "@/lib/api/schemas";
import type {
  LegacyHistoryImportResponse, LegacyHistoryPreview, LegacyImportSummary, LegacyReceiptImportSummary,
  LegacyReceiptPreview, LegacyWorkgroupResponse,
} from "@/lib/api/types";
import { asNetwork } from "@/lib/config";
import { plural } from "@/lib/format";
import { routes } from "@/lib/routes";
import type { LegacyAttestKind } from "@/lib/legacyHistory/attestation";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useCommunityGate } from "@/hooks/useCommunityGate";
import { useLegacyHistory } from "@/hooks/useLegacyHistory";
import { useWorkgroups } from "@/hooks/useWorkgroups";
import { HistoryImportList } from "@/components/legacyHistory/HistoryImportList";
import { HistoryPreview } from "@/components/legacyHistory/HistoryPreview";
import { HistoryUpload } from "@/components/legacyHistory/HistoryUpload";
import { LegacyPendingAttest } from "@/components/legacyHistory/LegacyPendingAttest";
import { LegacyWalletPanel } from "@/components/legacyHistory/LegacyWalletPanel";
import { ReceiptImportList } from "@/components/legacyHistory/ReceiptImportList";
import { ReceiptPreview } from "@/components/legacyHistory/ReceiptPreview";
import { ReceiptUpload } from "@/components/legacyHistory/ReceiptUpload";
import { Button, Card, ErrorText, LinkButton, NoticeText, PageTitle } from "@/components/ui";

type Track = "payments" | "receipts";

interface PaymentUpload {
  file: { name: string; text: string };
  tickerUnits: Record<string, string>;
  includeDuplicates: boolean;
}

interface ReceiptUploadState {
  file: { name: string; text: string };
  tickerUnits: Record<string, string>;
  sourceMap: Record<string, string>;
  commitmentMap: Record<string, string>;
  defaultSourceId: string | null;
  defaultCommitmentId: string | null;
  includeDuplicates: boolean;
}

export default function PaymentHistoryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const { community, blocked } = useCommunityGate(slug, { require: "admin" });
  const overview = useLegacyHistory(community?.id);
  const workgroups = useWorkgroups(community?.id, true);
  const [chosenWallet, setChosenWallet] = useState<string | null>(null);
  const [track, setTrack] = useState<Track>("payments");
  const [upload, setUpload] = useState<PaymentUpload | null>(null);
  const [receiptUpload, setReceiptUpload] = useState<ReceiptUploadState | null>(null);
  const [replacing, setReplacing] = useState<LegacyImportSummary | null>(null);
  const [replacingReceipt, setReplacingReceipt] = useState<LegacyReceiptImportSummary | null>(null);
  const [preview, setPreview] = useState<LegacyHistoryPreview | null>(null);
  const [receiptPreview, setReceiptPreview] = useState<LegacyReceiptPreview | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [pendingAttest, setPendingAttest] = useState<{
    kind: LegacyAttestKind;
    importId: string;
    planHash: string;
    signatures: number;
    required: number;
  } | null>(null);
  const review = useAsyncAction("Failed to read the file");
  const save = useAsyncAction("Failed to import the file");
  const mapping = useAsyncAction("Failed to save the workgroup");
  const busy = review.busy || save.busy || mapping.busy;

  if (blocked) return blocked;

  const wallets = overview.data?.wallets ?? [];
  const walletId = wallets.some((w) => w.id === chosenWallet) ? chosenWallet : wallets[0]?.id ?? null;
  const selectedWallet = wallets.find((w) => w.id === walletId) ?? null;
  const network = community ? asNetwork(community.network) : asNetwork(0);
  const imports = (overview.data?.imports ?? []).filter((i) => i.legacyWalletId === walletId);
  const receiptImports = (overview.data?.receiptImports ?? []).filter((i) => i.legacyWalletId === walletId);

  function paymentBody(state: PaymentUpload, replace: LegacyImportSummary | null): LegacyUploadBody {
    return {
      communityId: community!.id,
      legacyWalletId: walletId!,
      fileName: state.file.name,
      csv: state.file.text,
      tickerUnits: state.tickerUnits,
      includeDuplicates: state.includeDuplicates,
      replaceImportId: replace?.id ?? null,
    };
  }

  function receiptBody(state: ReceiptUploadState, replace: LegacyReceiptImportSummary | null): LegacyReceiptUploadBody {
    return {
      communityId: community!.id,
      legacyWalletId: walletId!,
      fileName: state.file.name,
      csv: state.file.text,
      tickerUnits: state.tickerUnits,
      sourceMap: state.sourceMap,
      commitmentMap: state.commitmentMap,
      defaultSourceId: state.defaultSourceId,
      defaultCommitmentId: state.defaultCommitmentId,
      includeDuplicates: state.includeDuplicates,
      replaceImportId: replace?.id ?? null,
    };
  }

  function reset() {
    setUpload(null);
    setReceiptUpload(null);
    setPreview(null);
    setReceiptPreview(null);
    setReplacing(null);
    setReplacingReceipt(null);
    setPendingAttest(null);
    review.setError(null);
    save.setError(null);
  }

  function switchTrack(next: Track) {
    if (next === track) return;
    setTrack(next);
    reset();
    setNotice(null);
    setPendingAttest(null);
  }

  async function runPaymentPreview(state: PaymentUpload, replace = replacing) {
    setUpload(state);
    setNotice(null);
    save.setError(null);
    const result = await review.run(() => apiFetch<LegacyHistoryPreview>("/api/legacy-history/preview", {
      body: paymentBody(state, replace),
    }));
    setPreview(result ?? null);
  }

  async function runReceiptPreview(state: ReceiptUploadState, replace = replacingReceipt) {
    setReceiptUpload(state);
    setNotice(null);
    save.setError(null);
    const result = await review.run(() => apiFetch<LegacyReceiptPreview>("/api/legacy-history/receipts/preview", {
      body: receiptBody(state, replace),
    }));
    setReceiptPreview(result ?? null);
  }

  async function resolveWorkgroup(resolution: Omit<LegacyWorkgroupBody, "communityId">) {
    const result = await mapping.run(() => apiFetch<LegacyWorkgroupResponse>("/api/legacy-history/workgroup", {
      body: { communityId: community!.id, ...resolution },
    }));
    if (!result) return;
    workgroups.reload();
    if (upload) await runPaymentPreview(upload);
  }

  async function runPaymentImport() {
    if (!upload) return;
    const result = await save.run(() => apiFetch<LegacyHistoryImportResponse>("/api/legacy-history/import", {
      body: paymentBody(upload, replacing),
    }));
    if (!result) return;
    if (result.state === "pending_signatures" && result.planHash) {
      reset();
      setPendingAttest({
        kind: "payments",
        importId: result.importId,
        planHash: result.planHash,
        signatures: result.signatures ?? 0,
        required: result.required ?? 1,
      });
      setNotice("Import staged. Sign with the previous wallet to activate it.");
      return;
    }
    reset();
    setNotice(
      `Imported ${plural(result.inserted ?? 0, "line")}${(result.skipped ?? 0) > 0 ? `; ${plural(result.skipped!, "line")} already here ${result.skipped === 1 ? "was" : "were"} skipped` : ""}.`,
    );
    overview.reload();
  }

  async function runReceiptImport() {
    if (!receiptUpload) return;
    const result = await save.run(() => apiFetch<LegacyHistoryImportResponse>("/api/legacy-history/receipts/import", {
      body: receiptBody(receiptUpload, replacingReceipt),
    }));
    if (!result) return;
    if (result.state === "pending_signatures" && result.planHash) {
      reset();
      setPendingAttest({
        kind: "receipts",
        importId: result.importId,
        planHash: result.planHash,
        signatures: result.signatures ?? 0,
        required: result.required ?? 1,
      });
      setNotice("Import staged. Sign with the previous wallet to activate it.");
      return;
    }
    reset();
    setNotice(
      `Imported ${plural(result.inserted ?? 0, "receipt")}${(result.skipped ?? 0) > 0 ? `; ${plural(result.skipped!, "line")} already here ${result.skipped === 1 ? "was" : "were"} skipped` : ""}.`,
    );
    overview.reload();
  }

  function attestDone() {
    setPendingAttest(null);
    setNotice("Import activated.");
    overview.reload();
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageTitle action={<LinkButton href={routes.treasury(slug)} variant="ghost">Back to treasury</LinkButton>}>
        Previous wallet history
      </PageTitle>
      <p className="-mt-2 text-sm text-zinc-400">
        Moved here from another wallet? Import its payments and receipts from CSVs that name each line&apos;s
        transaction hash, output index and full recipient address. The app verifies those rows against the chain,
        then a signer of the previous wallet must approve the import before it counts on the Dashboard.
      </p>
      <ErrorText error={overview.error} />

      {community && overview.data && (
        <LegacyWalletPanel
          communityId={community.id}
          wallets={wallets}
          selectedId={walletId}
          onSelect={(id) => { setChosenWallet(id); reset(); setNotice(null); }}
          onChanged={overview.reload}
        />
      )}

      {walletId && (
        <div className="flex gap-2 border-b border-zinc-800 pb-px">
          {([
            ["payments", "Payments"],
            ["receipts", "Receipts"],
          ] as const).map(([id, label]) => (
            <button
              key={id}
              type="button"
              onClick={() => switchTrack(id)}
              className={`-mb-px border-b-2 px-3 py-2 text-sm ${
                track === id
                  ? "border-zinc-100 text-zinc-100"
                  : "border-transparent text-zinc-500 hover:text-zinc-300"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {walletId && track === "payments" && (
        <Card className="space-y-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-medium">{replacing ? `Replace “${replacing.fileName}”` : "Import payments"}</h2>
              <p className="mt-1 text-sm text-zinc-400">
                Outflows paid from this wallet to workgroups. Lines already imported are skipped, so you can upload
                an updated file with a few forgotten payments.
              </p>
            </div>
            {replacing && <Button variant="ghost" onClick={reset} disabled={busy}>Cancel replace</Button>}
          </div>
          <HistoryUpload fileName={upload?.file.name ?? null} disabled={busy}
            onFile={(file) => void runPaymentPreview({ file, tickerUnits: {}, includeDuplicates: false })} />
          <ErrorText error={review.error ?? mapping.error} />
          {review.busy && !preview && <p className="text-sm text-zinc-500">Reading the file…</p>}
          {preview && upload && (
            <HistoryPreview
              preview={preview}
              network={network}
              workgroups={workgroups.data ?? []}
              includeDuplicates={upload.includeDuplicates}
              busy={busy}
              importing={save.busy}
              importError={save.error}
              replacing={replacing?.fileName ?? null}
              onIncludeDuplicates={(value) => void runPaymentPreview({ ...upload, includeDuplicates: value })}
              onTickerUnit={(ticker, unit) => void runPaymentPreview({ ...upload, tickerUnits: { ...upload.tickerUnits, [ticker]: unit } })}
              onWorkgroup={(resolution) => void resolveWorkgroup(resolution)}
              onImport={() => void runPaymentImport()}
            />
          )}
        </Card>
      )}

      {walletId && track === "receipts" && (
        <Card className="space-y-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-medium">
                {replacingReceipt ? `Replace “${replacingReceipt.fileName}”` : "Import receipts"}
              </h2>
              <p className="mt-1 text-sm text-zinc-400">
                Income this wallet received (for example from a funder). Tie lines to an existing funding source so
                they count as Received on the Funding page and feed the Dashboard funding flow into this previous
                wallet.
              </p>
            </div>
            {replacingReceipt && <Button variant="ghost" onClick={reset} disabled={busy}>Cancel replace</Button>}
          </div>
          <ReceiptUpload fileName={receiptUpload?.file.name ?? null} disabled={busy}
            onFile={(file) => void runReceiptPreview({
              file, tickerUnits: {}, sourceMap: {}, commitmentMap: {},
              defaultSourceId: null, defaultCommitmentId: null, includeDuplicates: false,
            })} />
          <ErrorText error={review.error} />
          {review.busy && !receiptPreview && <p className="text-sm text-zinc-500">Reading the file…</p>}
          {receiptPreview && receiptUpload && (
            <ReceiptPreview
              preview={receiptPreview}
              network={network}
              includeDuplicates={receiptUpload.includeDuplicates}
              busy={busy}
              importing={save.busy}
              importError={save.error}
              replacing={replacingReceipt?.fileName ?? null}
              onIncludeDuplicates={(value) => void runReceiptPreview({ ...receiptUpload, includeDuplicates: value })}
              onTickerUnit={(ticker, unit) => void runReceiptPreview({
                ...receiptUpload, tickerUnits: { ...receiptUpload.tickerUnits, [ticker]: unit },
              })}
              onSource={(ref, sourceId) => void runReceiptPreview({
                ...receiptUpload, sourceMap: { ...receiptUpload.sourceMap, [ref]: sourceId },
              })}
              onCommitment={(key, commitmentId) => void runReceiptPreview({
                ...receiptUpload, commitmentMap: { ...receiptUpload.commitmentMap, [key]: commitmentId },
              })}
              onDefaults={(sourceId, commitmentId) => void runReceiptPreview({
                ...receiptUpload, defaultSourceId: sourceId, defaultCommitmentId: commitmentId,
              })}
              onImport={() => void runReceiptImport()}
            />
          )}
        </Card>
      )}
      <NoticeText>{notice}</NoticeText>
      {community && selectedWallet && pendingAttest && (
        <LegacyPendingAttest
          communityId={community.id}
          communitySlug={slug}
          legacyWalletId={selectedWallet.id}
          walletAddress={selectedWallet.address}
          importId={pendingAttest.importId}
          planHash={pendingAttest.planHash}
          kind={pendingAttest.kind}
          signatures={pendingAttest.signatures}
          required={pendingAttest.required}
          onDone={attestDone}
        />
      )}

      {community && walletId && track === "payments" && (
        <HistoryImportList
          communityId={community.id}
          imports={imports}
          onReplace={(item) => {
            setReplacing(item);
            setNotice(null);
            if (upload) void runPaymentPreview(upload, item);
            else setPreview(null);
            window.scrollTo({ top: 0, behavior: "smooth" });
          }}
          onChanged={overview.reload}
        />
      )}

      {community && walletId && track === "receipts" && (
        <ReceiptImportList
          communityId={community.id}
          imports={receiptImports}
          onReplace={(item) => {
            setReplacingReceipt(item);
            setNotice(null);
            if (receiptUpload) void runReceiptPreview(receiptUpload, item);
            else setReceiptPreview(null);
            window.scrollTo({ top: 0, behavior: "smooth" });
          }}
          onChanged={overview.reload}
        />
      )}
    </div>
  );
}
