"use client";

// The lines one receipts import added, a page at a time, each removable.
import { useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { LegacyReceiptRowsResponse, OkResponse } from "@/lib/api/types";
import { plural } from "@/lib/format";
import { formatAmounts, formatDay } from "@/lib/legacyHistory/display";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useAsyncData } from "@/hooks/useAsyncData";
import { Button, ConfirmDialog, ErrorText } from "@/components/ui";

const PAGE = 200;

export function ReceiptRowsTable({
  communityId,
  importId,
  onChanged,
}: {
  communityId: string;
  importId: string;
  onChanged: () => void;
}) {
  const [offset, setOffset] = useState(0);
  const [version, setVersion] = useState(0);
  const [removing, setRemoving] = useState<{ id: string; label: string } | null>(null);
  const page = useAsyncData(
    `${communityId}:${importId}:${offset}:${version}`,
    () => apiFetch<LegacyReceiptRowsResponse>("/api/legacy-history/receipts/rows", {
      query: { communityId, importId, offset },
    }),
  );
  const remove = useAsyncAction("Failed to remove the line");

  async function confirmRemove() {
    if (!removing) return;
    const result = await remove.run(() =>
      apiFetch<OkResponse>(`/api/legacy-history/receipts/rows/${removing.id}`, { method: "DELETE" }));
    if (!result) return;
    setRemoving(null);
    setVersion((v) => v + 1);
    onChanged();
  }

  const data = page.data;
  return (
    <div className="space-y-2">
      <ErrorText error={page.error} />
      {data && (
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-zinc-500">
              <tr>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Source</th>
                <th className="px-3 py-2">Commitment</th>
                <th className="px-3 py-2">Note</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {data.rows.map((row) => (
                <tr key={row.id} className="align-top">
                  <td className="whitespace-nowrap px-3 py-2">{formatDay(row.receivedOn)}</td>
                  <td className="px-3 py-2">{row.fundingSourceName ?? "—"}</td>
                  <td className="px-3 py-2">{row.fundingCommitmentName ?? "—"}</td>
                  <td className="px-3 py-2"><p className="max-w-xs break-words">{row.note ?? "—"}</p></td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-xs">{formatAmounts(row.amounts)}</td>
                  <td className="px-3 py-2 text-right">
                    <Button variant="ghost" className="!px-2 !py-1 text-xs"
                      onClick={() => setRemoving({
                        id: row.id,
                        label: row.note ?? `${formatDay(row.receivedOn)} receipt`,
                      })}>
                      Remove
                    </Button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {data && data.total > PAGE && (
        <div className="flex items-center gap-2 text-xs text-zinc-500">
          <Button variant="secondary" disabled={offset === 0 || page.loading} onClick={() => setOffset((o) => Math.max(0, o - PAGE))}>
            Previous
          </Button>
          <span>{offset + 1}–{Math.min(offset + PAGE, data.total)} of {plural(data.total, "line")}</span>
          <Button variant="secondary" disabled={offset + PAGE >= data.total || page.loading} onClick={() => setOffset((o) => o + PAGE)}>
            Next
          </Button>
        </div>
      )}
      <ConfirmDialog open={!!removing} title="Remove this line?" confirmLabel="Remove" busy={remove.busy}
        error={remove.error} onConfirm={() => void confirmRemove()}
        onCancel={() => { setRemoving(null); remove.setError(null); }}>
        “{removing?.label}” leaves the Dashboard and Funding received totals. Importing a file that contains it again
        adds it back.
      </ConfirmDialog>
    </div>
  );
}
