"use client";

// Payment history from a previous wallet: an admin uploads a CSV the
// community exported and audited itself, previews it, and imports it. The
// lines count on the Dashboard as workgroup spend paid from that wallet.
import { use, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { LegacyUploadBody, LegacyWorkgroupBody } from "@/lib/api/schemas";
import type {
  LegacyHistoryImportResponse, LegacyHistoryPreview, LegacyImportSummary, LegacyWorkgroupResponse,
} from "@/lib/api/types";
import { plural } from "@/lib/format";
import { routes } from "@/lib/routes";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useCommunityGate } from "@/hooks/useCommunityGate";
import { useLegacyHistory } from "@/hooks/useLegacyHistory";
import { useWorkgroups } from "@/hooks/useWorkgroups";
import { HistoryImportList } from "@/components/legacyHistory/HistoryImportList";
import { HistoryPreview } from "@/components/legacyHistory/HistoryPreview";
import { HistoryUpload } from "@/components/legacyHistory/HistoryUpload";
import { LegacyWalletPanel } from "@/components/legacyHistory/LegacyWalletPanel";
import { Button, Card, ErrorText, LinkButton, NoticeText, PageTitle } from "@/components/ui";

interface UploadState {
  file: { name: string; text: string };
  tickerUnits: Record<string, string>;
  includeDuplicates: boolean;
}

export default function PaymentHistoryPage({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const { community, blocked } = useCommunityGate(slug, { require: "admin" });
  const overview = useLegacyHistory(community?.id);
  const workgroups = useWorkgroups(community?.id, true);
  const [chosenWallet, setChosenWallet] = useState<string | null>(null);
  const [upload, setUpload] = useState<UploadState | null>(null);
  const [replacing, setReplacing] = useState<LegacyImportSummary | null>(null);
  const [preview, setPreview] = useState<LegacyHistoryPreview | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const review = useAsyncAction("Failed to read the file");
  const save = useAsyncAction("Failed to import the file");
  const mapping = useAsyncAction("Failed to save the workgroup");
  const busy = review.busy || save.busy || mapping.busy;

  if (blocked) return blocked;

  const wallets = overview.data?.wallets ?? [];
  const walletId = wallets.some((w) => w.id === chosenWallet) ? chosenWallet : wallets[0]?.id ?? null;
  const imports = (overview.data?.imports ?? []).filter((i) => i.legacyWalletId === walletId);

  function body(state: UploadState, replace: LegacyImportSummary | null): LegacyUploadBody {
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

  async function runPreview(state: UploadState, replace = replacing) {
    setUpload(state);
    setNotice(null);
    save.setError(null);
    const result = await review.run(() => apiFetch<LegacyHistoryPreview>("/api/legacy-history/preview", {
      body: body(state, replace),
    }));
    setPreview(result ?? null);
  }

  function reset() {
    setUpload(null);
    setPreview(null);
    setReplacing(null);
    review.setError(null);
    save.setError(null);
  }

  async function resolveWorkgroup(resolution: Omit<LegacyWorkgroupBody, "communityId">) {
    const result = await mapping.run(() => apiFetch<LegacyWorkgroupResponse>("/api/legacy-history/workgroup", {
      body: { communityId: community!.id, ...resolution },
    }));
    if (!result) return;
    workgroups.reload();
    if (upload) await runPreview(upload);
  }

  async function runImport() {
    if (!upload) return;
    const result = await save.run(() => apiFetch<LegacyHistoryImportResponse>("/api/legacy-history/import", {
      body: body(upload, replacing),
    }));
    if (!result) return;
    reset();
    setNotice(
      `Imported ${plural(result.inserted, "line")}${result.skipped > 0 ? `; ${plural(result.skipped, "line")} already here ${result.skipped === 1 ? "was" : "were"} skipped` : ""}.`,
    );
    overview.reload();
  }

  return (
    <div className="mx-auto max-w-4xl space-y-6">
      <PageTitle action={<LinkButton href={routes.treasury(slug)} variant="ghost">Back to treasury</LinkButton>}>
        Payment history
      </PageTitle>
      <p className="-mt-2 text-sm text-zinc-400">
        Moved here from another wallet? Import its payments from a CSV so the Dashboard and budgets show everything
        your workgroups were paid. Treasury Guild never reads the old wallet: the file is taken as it is, so check it
        before importing. You can delete or replace an import at any time.
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
        <Card className="space-y-5">
          <div className="flex items-start justify-between gap-3">
            <div>
              <h2 className="text-lg font-medium">{replacing ? `Replace “${replacing.fileName}”` : "Import a CSV"}</h2>
              <p className="mt-1 text-sm text-zinc-400">
                Lines already imported for this wallet are recognised and skipped, so you can upload an updated
                file with a few forgotten payments and only those are added.
              </p>
            </div>
            {replacing && <Button variant="ghost" onClick={reset} disabled={busy}>Cancel replace</Button>}
          </div>
          <HistoryUpload fileName={upload?.file.name ?? null} disabled={busy}
            onFile={(file) => void runPreview({ file, tickerUnits: {}, includeDuplicates: false })} />
          <ErrorText error={review.error ?? mapping.error} />
          {review.busy && !preview && <p className="text-sm text-zinc-500">Reading the file…</p>}
          {preview && upload && (
            <HistoryPreview
              preview={preview}
              workgroups={workgroups.data ?? []}
              includeDuplicates={upload.includeDuplicates}
              busy={busy}
              importing={save.busy}
              importError={save.error}
              replacing={replacing?.fileName ?? null}
              onIncludeDuplicates={(value) => void runPreview({ ...upload, includeDuplicates: value })}
              onTickerUnit={(ticker, unit) => void runPreview({ ...upload, tickerUnits: { ...upload.tickerUnits, [ticker]: unit } })}
              onWorkgroup={(resolution) => void resolveWorkgroup(resolution)}
              onImport={() => void runImport()}
            />
          )}
        </Card>
      )}
      <NoticeText>{notice}</NoticeText>

      {community && walletId && (
        <HistoryImportList
          communityId={community.id}
          imports={imports}
          onReplace={(item) => {
            setReplacing(item);
            setNotice(null);
            if (upload) void runPreview(upload, item);
            else setPreview(null);
            window.scrollTo({ top: 0, behavior: "smooth" });
          }}
          onChanged={overview.reload}
        />
      )}
    </div>
  );
}
