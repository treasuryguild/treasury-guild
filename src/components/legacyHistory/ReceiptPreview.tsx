"use client";

// What an uploaded receipts CSV would import. Nothing is written until Import.
import { useState } from "react";
import type { LegacyReceiptPreview } from "@/lib/api/types";
import type { Network } from "@/lib/config";
import { explorerTxUrl } from "@/lib/config";
import { formatUnits, plural } from "@/lib/format";
import { formatDay } from "@/lib/legacyHistory/display";
import { receiptIssueText } from "@/lib/legacyHistory/receiptIssueText";
import type { CommitmentResolution, PlannedReceiptRow, SourceResolution } from "@/lib/legacyHistory/receiptTypes";
import type { LegacyIssue } from "@/lib/legacyHistory/types";
import { Badge, Button, ErrorText, Select, WarningText } from "@/components/ui";
import { TickerResolver } from "./HistoryMappings";

function statusBadge(row: PlannedReceiptRow) {
  if (row.status === "invalid") return <Badge tone="red">Error</Badge>;
  if (row.status === "duplicate") return <Badge tone="yellow">Already imported</Badge>;
  if (row.duplicateOfLine !== null) return <Badge tone="yellow">Repeats line {row.duplicateOfLine}</Badge>;
  return <Badge tone="green">New</Badge>;
}

function SourceResolver({
  resolution,
  busy,
  onChoose,
}: {
  resolution: Exclude<SourceResolution, { status: "resolved" | "none" }>;
  busy: boolean;
  onChoose: (sourceId: string) => void;
}) {
  const [target, setTarget] = useState("");
  if (resolution.status === "missing") {
    return (
      <WarningText>
        Funding source “{resolution.name}” is not in this community. Create it on the Funding page (or fix the name
        in the file) and preview again.
      </WarningText>
    );
  }
  return (
    <div className="space-y-2 rounded-lg border border-zinc-700 p-3">
      <p className="text-sm">
        Funding source <span className="font-medium">“{resolution.name}”</span>: several sources match. Choose one.
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Select aria-label={`Source for ${resolution.name}`} value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">Choose a source…</option>
          {resolution.candidates.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </Select>
        <Button variant="secondary" disabled={busy || !target} onClick={() => onChoose(target)}>Use this source</Button>
      </div>
    </div>
  );
}

function CommitmentResolver({
  resolution,
  busy,
  onChoose,
}: {
  resolution: Exclude<CommitmentResolution, { status: "resolved" | "none" }>;
  busy: boolean;
  onChoose: (commitmentId: string) => void;
}) {
  const [target, setTarget] = useState("");
  if (resolution.status === "missing") {
    return (
      <WarningText>
        Commitment “{resolution.name}” could not be matched under its funding source. Create it on the Funding page
        or fix the name in the file.
      </WarningText>
    );
  }
  return (
    <div className="space-y-2 rounded-lg border border-zinc-700 p-3">
      <p className="text-sm">
        Commitment <span className="font-medium">“{resolution.name}”</span>: several match. Choose one.
      </p>
      <div className="flex flex-col gap-2 sm:flex-row">
        <Select aria-label={`Commitment for ${resolution.name}`} value={target} onChange={(e) => setTarget(e.target.value)}>
          <option value="">Choose a commitment…</option>
          {resolution.candidates.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </Select>
        <Button variant="secondary" disabled={busy || !target} onClick={() => onChoose(target)}>Use this commitment</Button>
      </div>
    </div>
  );
}

function UntaggedDefaults({
  untaggedCount,
  sources,
  commitments,
  sourceId,
  commitmentId,
  busy,
  onChange,
}: {
  untaggedCount: number;
  sources: { id: string; name: string }[];
  commitments: { id: string; sourceId: string; name: string }[];
  sourceId: string | null;
  commitmentId: string | null;
  busy: boolean;
  onChange: (sourceId: string | null, commitmentId: string | null) => void;
}) {
  const underSource = commitments.filter((c) => c.sourceId === sourceId);
  return (
    <div className="space-y-3 rounded-lg border border-zinc-700 p-3">
      <p className="text-sm text-zinc-300">
        {plural(untaggedCount, "line")} {untaggedCount === 1 ? "has" : "have"} no funding source in the file.
        Choose one to tag {untaggedCount === 1 ? "it" : "them"} all (so they count as Received), or leave blank
        for unclassified Dashboard income.
      </p>
      {sources.length === 0 ? (
        <WarningText>
          No funding sources yet. Create one on the Funding page, then choose the file again.
        </WarningText>
      ) : (
        <div className="flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end">
          <label className="space-y-1 text-sm">
            <span className="text-zinc-500">Funding source</span>
            <Select
              aria-label="Funding source for untagged lines"
              value={sourceId ?? ""}
              disabled={busy}
              onChange={(e) => onChange(e.target.value || null, null)}
            >
              <option value="">Leave untagged</option>
              {sources.map((s) => (
                <option key={s.id} value={s.id}>{s.name}</option>
              ))}
            </Select>
          </label>
          {sourceId && underSource.length > 0 && (
            <label className="space-y-1 text-sm">
              <span className="text-zinc-500">Commitment (optional)</span>
              <Select
                aria-label="Commitment for untagged lines"
                value={commitmentId ?? ""}
                disabled={busy}
                onChange={(e) => onChange(sourceId, e.target.value || null)}
              >
                <option value="">None</option>
                {underSource.map((c) => (
                  <option key={c.id} value={c.id}>{c.name}</option>
                ))}
              </Select>
            </label>
          )}
        </div>
      )}
    </div>
  );
}

export function ReceiptPreview({
  preview,
  network,
  includeDuplicates,
  busy,
  importing,
  importError,
  replacing,
  onIncludeDuplicates,
  onTickerUnit,
  onSource,
  onCommitment,
  onDefaults,
  onImport,
}: {
  preview: LegacyReceiptPreview;
  network: Network;
  includeDuplicates: boolean;
  busy: boolean;
  importing: boolean;
  importError: string | null;
  replacing: string | null;
  onIncludeDuplicates: (value: boolean) => void;
  onTickerUnit: (ticker: string, unit: string) => void;
  onSource: (ref: string, sourceId: string) => void;
  onCommitment: (key: string, commitmentId: string) => void;
  onDefaults: (sourceId: string | null, commitmentId: string | null) => void;
  onImport: () => void;
}) {
  const { counts } = preview;
  const fileIssues = preview.issues.filter((i) => i.line === null);
  const lineIssues = new Map<number, LegacyIssue[]>();
  for (const issue of preview.issues) {
    if (issue.line !== null) lineIssues.set(issue.line, [...(lineIssues.get(issue.line) ?? []), issue]);
  }
  const rowLines = new Set(preview.rows.map((r) => r.line));
  const unparsed = [...lineIssues].filter(([line]) => !rowLines.has(line));
  const toImport = counts.new + (includeDuplicates ? counts.duplicates : 0);
  const untaggedCount = preview.rows.filter((r) => r.sourceRef === "").length;
  const sourceNames = new Map<string, string>();
  for (const s of preview.availableSources) sourceNames.set(s.id, s.name);
  for (const s of preview.sources) if (s.status === "resolved") sourceNames.set(s.source.id, s.source.name);
  const commitmentNames = new Map<string, string>();
  for (const c of preview.availableCommitments) commitmentNames.set(c.id, c.name);
  for (const c of preview.commitments) {
    if (c.status === "resolved") commitmentNames.set(c.commitment.id, c.commitment.name);
  }

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
            <li key={i}>{receiptIssueText(issue)}</li>
          ))}
        </ul>
      )}

      {preview.tickers.map((t) => t.status !== "resolved" && (
        <TickerResolver key={`${t.ticker}:${t.status === "unknown" ? t.manualUnit ?? "" : ""}`} resolution={t}
          busy={busy} onChoose={(unit) => onTickerUnit(t.ticker, unit)} />
      ))}
      {preview.sources.map((s) => s.status !== "resolved" && s.status !== "none" && (
        <SourceResolver key={s.ref} resolution={s} busy={busy} onChoose={(id) => onSource(s.ref, id)} />
      ))}
      {preview.commitments.map((c) => {
        if (c.status === "resolved" || c.status === "none") return null;
        const sourceId = c.status === "ambiguous" ? c.candidates[0]?.sourceId
          : preview.sources.find((s) => s.ref !== "" && s.status === "resolved")?.status === "resolved"
            ? undefined
            : undefined;
        const keySource = c.status === "ambiguous"
          ? c.candidates[0]!.sourceId
          : [...preview.rows].find((r) => r.commitmentRef === c.ref)?.sourceId ?? "";
        return (
          <CommitmentResolver key={`${keySource}|${c.ref}`} resolution={c} busy={busy}
            onChoose={(id) => onCommitment(`${keySource || sourceId || ""}|${c.ref}`, id)} />
        );
      })}
      {untaggedCount > 0 && (
        <UntaggedDefaults
          untaggedCount={untaggedCount}
          sources={preview.availableSources}
          commitments={preview.availableCommitments}
          sourceId={preview.defaultSourceId}
          commitmentId={preview.defaultCommitmentId}
          busy={busy}
          onChange={onDefaults}
        />
      )}

      {unparsed.length > 0 && (
        <div>
          <h3 className="mb-2 text-sm font-medium">Lines that cannot be read</h3>
          <ul className="space-y-1 text-sm text-amber-300">
            {unparsed.map(([line, issues]) => (
              <li key={line}>Line {line}: {issues.map(receiptIssueText).join(" ")}</li>
            ))}
          </ul>
        </div>
      )}

      {preview.rows.length > 0 && (
        <div className="overflow-x-auto rounded-lg border border-zinc-800">
          <table className="w-full text-left text-sm">
            <thead className="text-xs text-zinc-500">
              <tr>
                <th className="px-3 py-2">Status</th>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Tx</th>
                <th className="px-3 py-2">Source</th>
                <th className="px-3 py-2">Commitment</th>
                <th className="px-3 py-2">Note</th>
                <th className="px-3 py-2 text-right">Amount</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-zinc-800">
              {preview.rows.map((row) => (
                <tr key={row.line} className="align-top">
                  <td className="px-3 py-2">{statusBadge(row)}</td>
                  <td className="whitespace-nowrap px-3 py-2">{formatDay(row.receivedOn)}</td>
                  <td className="whitespace-nowrap px-3 py-2 font-mono text-xs">
                    <a href={explorerTxUrl(network, row.txHash)} target="_blank" rel="noreferrer"
                      className="text-sky-400 hover:underline">
                      …{row.txHash.slice(-8)}:{row.outputIndex}
                    </a>
                    {(lineIssues.get(row.line) ?? []).map((issue, i) => (
                      <p key={i} className={`mt-1 text-xs ${issue.severity === "error" ? "text-red-400" : "text-amber-300"}`}>
                        {receiptIssueText(issue)}
                      </p>
                    ))}
                  </td>
                  <td className="px-3 py-2">
                    {row.sourceId ? (sourceNames.get(row.sourceId) ?? row.sourceRef) : row.sourceRef || "—"}
                  </td>
                  <td className="px-3 py-2">
                    {row.commitmentId
                      ? (commitmentNames.get(row.commitmentId) ?? row.commitmentRef)
                      : row.commitmentRef || "—"}
                  </td>
                  <td className="px-3 py-2"><p className="max-w-xs break-words">{row.note ?? "—"}</p></td>
                  <td className="whitespace-nowrap px-3 py-2 text-right font-mono text-xs">
                    {row.amounts
                      .filter((a) => a.quantity !== null)
                      .map((a) => `${formatUnits(a.quantity!, a.decimals ?? 0)} ${a.ticker}`)
                      .join(", ")}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
          {preview.rowsTruncated && (
            <p className="border-t border-zinc-800 px-3 py-2 text-xs text-zinc-500">
              Showing a sample of the lines; every valid new line is still imported.
            </p>
          )}
        </div>
      )}

      {preview.totals.length > 0 && (
        <p className="text-sm text-zinc-400">
          Totals to import:{" "}
          <span className="font-mono text-zinc-200">
            {preview.totals.map((t) => `${formatUnits(t.amount, t.decimals)} ${t.ticker}`).join(", ")}
          </span>
        </p>
      )}

      {counts.duplicates > 0 && (
        <label className="flex items-center gap-2 text-sm text-zinc-300">
          <input type="checkbox" checked={includeDuplicates} disabled={busy}
            onChange={(e) => onIncludeDuplicates(e.target.checked)} />
          Also import the lines already imported
        </label>
      )}

      <ErrorText error={importError} />
      <Button disabled={!preview.ready || busy || toImport === 0} onClick={onImport}>
        {importing
          ? "Importing…"
          : replacing
            ? `Replace with ${plural(toImport, "line")}`
            : `Import ${plural(toImport, "line")}`}
      </Button>
    </div>
  );
}
