"use client";

// What an uploaded CSV would import: counts, what blocks it, the tokens and
// workgroups still to settle, the lines with their status, and the totals.
// Nothing is written until "Import".
import type { LegacyWorkgroupBody } from "@/lib/api/schemas";
import type { LegacyHistoryPreview } from "@/lib/api/types";
import { formatUnits, plural } from "@/lib/format";
import { formatDay } from "@/lib/legacyHistory/display";
import { legacyIssueText } from "@/lib/legacyHistory/issueText";
import type { LegacyIssue, PlannedRow } from "@/lib/legacyHistory/types";
import type { WorkgroupSummary } from "@/hooks/useWorkgroups";
import { Badge, Button, ErrorText, WarningText } from "@/components/ui";
import { TickerResolver, WorkgroupResolver } from "./HistoryMappings";

function statusBadge(row: PlannedRow) {
  if (row.status === "invalid") return <Badge tone="red">Error</Badge>;
  if (row.status === "duplicate") return <Badge tone="yellow">Already imported</Badge>;
  if (row.duplicateOfLine !== null) return <Badge tone="yellow">Repeats line {row.duplicateOfLine}</Badge>;
  return <Badge tone="green">New</Badge>;
}

export function HistoryPreview({
  preview,
  workgroups,
  includeDuplicates,
  busy,
  importing,
  importError,
  replacing,
  onIncludeDuplicates,
  onTickerUnit,
  onWorkgroup,
  onImport,
}: {
  preview: LegacyHistoryPreview;
  workgroups: WorkgroupSummary[];
  includeDuplicates: boolean;
  busy: boolean;
  importing: boolean;
  importError: string | null;
  /** The file name of the batch this upload replaces, if any. */
  replacing: string | null;
  onIncludeDuplicates: (value: boolean) => void;
  onTickerUnit: (ticker: string, unit: string) => void;
  onWorkgroup: (body: Omit<LegacyWorkgroupBody, "communityId">) => void;
  onImport: () => void;
}) {
  const { counts } = preview;
  const fileIssues = preview.issues.filter((i) => i.line === null);
  const lineIssues = new Map<number, LegacyIssue[]>();
  for (const issue of preview.issues) {
    if (issue.line !== null) lineIssues.set(issue.line, [...(lineIssues.get(issue.line) ?? []), issue]);
  }
  // Lines that failed to parse have no row: list their issues on their own.
  const rowLines = new Set(preview.rows.map((r) => r.line));
  const unparsed = [...lineIssues].filter(([line]) => !rowLines.has(line));
  const names = new Map<string, string>();
  for (const w of preview.workgroups) if (w.status === "resolved") names.set(w.workgroup.id, w.workgroup.name);
  const toImport = counts.new + (includeDuplicates ? counts.duplicates : 0);
  const overall = preview.totals.filter((t) => t.workgroupId === null);
  const byWorkgroup = preview.totals.filter((t) => t.workgroupId !== null);

  return (
    <div className="space-y-5">
      <p className="text-sm text-zinc-300">
        {plural(counts.lines, "line")}: {counts.new} new
        {counts.duplicates > 0 && `, ${counts.duplicates} already imported`}
        {counts.invalid > 0 && `, ${plural(counts.invalid, "line")} with errors`}.
      </p>

      {fileIssues.length > 0 && (
        <ul className="list-disc space-y-1 pl-5 text-sm text-amber-300">
          {fileIssues.map((issue, i) => (
            <li key={i}>{legacyIssueText(issue)}</li>
          ))}
        </ul>
      )}

      {preview.tickers.map((t) => t.status !== "resolved" && (
        <TickerResolver key={`${t.ticker}:${t.status === "unknown" ? t.manualUnit ?? "" : ""}`} resolution={t}
          busy={busy} onChoose={(unit) => onTickerUnit(t.ticker, unit)} />
      ))}
      {preview.workgroups.map((w) => w.status !== "resolved" && (
        <WorkgroupResolver key={w.ref} resolution={w} workgroups={workgroups} busy={busy} onResolve={onWorkgroup} />
      ))}

      {unparsed.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-medium">Lines that cannot be read</h3>
          <ul className="space-y-1 text-sm text-amber-300">
            {unparsed.map(([line, issues]) => (
              <li key={line}>Line {line}: {issues.map(legacyIssueText).join(" ")}</li>
            ))}
          </ul>
        </div>
      )}

      {preview.rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-zinc-500">
              <tr>
                <th className="px-3 py-2">Line</th>
                <th className="px-3 py-2">Recipient</th>
                <th className="px-3 py-2">Task</th>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Workgroup</th>
                <th className="px-3 py-2 text-right">Amount</th>
                <th className="px-3 py-2">Status</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {preview.rows.map((row) => (
                <tr key={row.line} className="align-top">
                  <td className="px-3 py-2 text-zinc-500">{row.line}</td>
                  <td className="px-3 py-2 font-mono text-xs">…{row.recipientRef.slice(-6)}</td>
                  <td className="px-3 py-2">
                    <p className="max-w-xs break-words">{row.task}</p>
                    {(lineIssues.get(row.line) ?? []).map((issue, i) => (
                      <p key={i} className={`mt-1 text-xs ${issue.severity === "error" ? "text-red-400" : "text-amber-300"}`}>
                        {legacyIssueText(issue)}
                      </p>
                    ))}
                  </td>
                  <td className="whitespace-nowrap px-3 py-2">{formatDay(row.paidOn)}</td>
                  <td className="px-3 py-2">{row.workgroupId ? names.get(row.workgroupId) : row.workgroupRef}</td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-xs">
                    {row.amounts.map((a) => <div key={a.ticker}>{a.raw} {a.ticker}</div>)}
                  </td>
                  <td className="px-3 py-2">{statusBadge(row)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {preview.rowsTruncated && (
            <p className="px-3 py-2 text-xs text-zinc-500">
              Showing every line that needs attention and the first clean lines; all {counts.lines} are imported.
            </p>
          )}
        </div>
      )}

      {overall.length > 0 && (
        <div className="space-y-1 text-sm">
          <p className="text-zinc-400">This import adds:</p>
          {byWorkgroup.map((t) => (
            <p key={`${t.workgroupId}:${t.unit}`}>
              {names.get(t.workgroupId!) ?? "Workgroup"}: <span className="font-mono">{formatUnits(t.amount, t.decimals, t.ticker)}</span>
            </p>
          ))}
          <p className="font-medium">
            Total: <span className="font-mono">{overall.map((t) => formatUnits(t.amount, t.decimals, t.ticker)).join(", ")}</span>
          </p>
        </div>
      )}

      {counts.duplicates > 0 && (
        <label className="flex items-start gap-2 text-sm text-zinc-300">
          <input type="checkbox" className="mt-1" checked={includeDuplicates} disabled={busy}
            onChange={(e) => onIncludeDuplicates(e.target.checked)} />
          <span>
            Also import the {plural(counts.duplicates, "line")} already imported for this wallet. Only tick this if they
            are separate payments that happen to look the same.
          </span>
        </label>
      )}

      {replacing && (
        <WarningText small>
          Importing replaces “{replacing}”: its lines are removed and this file&apos;s lines take their place.
        </WarningText>
      )}
      <ErrorText error={importError} />
      <Button onClick={onImport} loading={importing} disabled={busy || !preview.ready}>
        {toImport > 0 ? `Import ${plural(toImport, "line")}` : "Nothing new to import"}
      </Button>
    </div>
  );
}
