"use client";

// The lines one history import added, a page at a time, each removable.
import { useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { OkResponse } from "@/lib/api/types";
import { plural } from "@/lib/format";
import { formatAmounts, formatDay } from "@/lib/legacyHistory/display";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useLegacyRows } from "@/hooks/useLegacyHistory";
import { Button, ConfirmDialog, ErrorText } from "@/components/ui";

const PAGE = 200;

export function HistoryRowsTable({
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
  const [removing, setRemoving] = useState<{ id: string; task: string } | null>(null);
  const page = useLegacyRows(communityId, importId, offset, version);
  const remove = useAsyncAction("Failed to remove the line");

  async function confirmRemove() {
    if (!removing) return;
    const result = await remove.run(() => apiFetch<OkResponse>(`/api/legacy-history/rows/${removing.id}`, { method: "DELETE" }));
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
                <th className="px-3 py-2">Recipient</th>
                <th className="px-3 py-2">Task</th>
                <th className="px-3 py-2">Workgroup</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2"><span className="sr-only">Actions</span></th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {data.rows.map((row) => (
                <tr key={row.id} className="align-top">
                  <td className="whitespace-nowrap px-3 py-2">{formatDay(row.paidOn)}</td>
                  <td className="px-3 py-2" title={`Address ending ${row.recipientRef}`}>{row.recipientLabel}</td>
                  <td className="px-3 py-2"><p className="max-w-xs break-words">{row.task}</p></td>
                  <td className="px-3 py-2">{row.workgroupName}{row.workgroupArchived ? " (archived)" : ""}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-xs">{formatAmounts(row.amounts)}</td>
                  <td className="px-3 py-2 text-right">
                    <Button variant="ghost" className="!px-2 !py-1 text-xs"
                      onClick={() => setRemoving({ id: row.id, task: row.task })}>
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
        “{removing?.task}” leaves the Dashboard and budgets. Importing a file that contains it again adds it back.
      </ConfirmDialog>
    </div>
  );
}
