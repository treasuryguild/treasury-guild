"use client";

// The receipts CSV files imported for a previous wallet.
import { useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { LegacyReceiptImportSummary, OkResponse } from "@/lib/api/types";
import { formatDate, plural } from "@/lib/format";
import { formatAmounts, formatDay } from "@/lib/legacyHistory/display";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { Button, Card, ConfirmDialog, EmptyState, SectionTitle } from "@/components/ui";
import { ReceiptRowsTable } from "./ReceiptRowsTable";

export function ReceiptImportList({
  communityId,
  imports,
  onReplace,
  onChanged,
}: {
  communityId: string;
  imports: LegacyReceiptImportSummary[];
  onReplace: (item: LegacyReceiptImportSummary) => void;
  onChanged: () => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<LegacyReceiptImportSummary | null>(null);
  const remove = useAsyncAction("Failed to delete the import");

  async function confirmDelete() {
    if (!deleting) return;
    const result = await remove.run(() =>
      apiFetch<OkResponse>(`/api/legacy-history/receipts/imports/${deleting.id}`, { method: "DELETE" }));
    if (!result) return;
    if (open === deleting.id) setOpen(null);
    setDeleting(null);
    onChanged();
  }

  return (
    <section>
      <SectionTitle>Imported receipt files</SectionTitle>
      {imports.length === 0 ? (
        <EmptyState>No receipts imported for this wallet yet.</EmptyState>
      ) : (
        <div className="space-y-3">
          {imports.map((item) => (
            <Card key={item.id} className="space-y-3 py-4">
              <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-start">
                <div className="min-w-0">
                  <p className="truncate text-sm font-medium">{item.fileName}</p>
                  <p className="mt-1 text-xs text-zinc-500">
                    Imported {formatDate(item.createdAt, "datetime")} · {plural(item.rowCount, "line")}
                    {item.rowCount < item.lineCount && ` (${item.lineCount - item.rowCount} removed)`}
                    {item.firstReceivedOn && ` · ${formatDay(item.firstReceivedOn)} – ${formatDay(item.lastReceivedOn!)}`}
                  </p>
                  {item.totals.length > 0 && <p className="mt-1 font-mono text-xs">{formatAmounts(item.totals)}</p>}
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  <Button variant="secondary" onClick={() => setOpen(open === item.id ? null : item.id)}>
                    {open === item.id ? "Hide lines" : "View lines"}
                  </Button>
                  <Button variant="secondary" onClick={() => onReplace(item)}>Replace</Button>
                  <Button variant="secondary" onClick={() => setDeleting(item)}>Delete</Button>
                </div>
              </div>
              {open === item.id && <ReceiptRowsTable communityId={communityId} importId={item.id} onChanged={onChanged} />}
            </Card>
          ))}
        </div>
      )}
      <ConfirmDialog open={!!deleting} title="Delete this import?" confirmLabel="Delete import" busy={remove.busy}
        error={remove.error} onConfirm={() => void confirmDelete()}
        onCancel={() => { setDeleting(null); remove.setError(null); }}>
        The {plural(deleting?.rowCount ?? 0, "line")} of “{deleting?.fileName}” leave the Dashboard and Funding
        received totals. You can import the file again afterwards.
      </ConfirmDialog>
    </section>
  );
}
