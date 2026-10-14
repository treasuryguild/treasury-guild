"use client";

// One funding source: its totals against the plan, each commitment (with its
// periods for recurring ones and schedules), what arrived tied to the source
// alone, and the inflows behind the received amounts.
import { useState } from "react";
import type { FundingCommitmentRow, FundingPeriodRow, FundingSourceRow } from "@/lib/db/types";
import { describeCommitment, formatFundingAmount, type FundingTokenOption } from "@/lib/funding/display";
import type { SourceSummary } from "@/lib/funding/plan";
import { formatDate, shortHash } from "@/lib/format";
import { routes } from "@/lib/routes";
import type { FundingData } from "@/hooks/useFunding";
import { Button, Card, LinkButton } from "@/components/ui";
import { DifferenceBadge, FundingFigures } from "./FundingFigures";

function amountsText(values: Record<string, string>, options: readonly FundingTokenOption[]): string {
  const entries = Object.entries(values).filter(([, v]) => v !== "0");
  return entries.length ? entries.map(([unit, v]) => formatFundingAmount(unit, v, options)).join(", ") : "—";
}

export function FundingSourceCard({
  slug, source, summary, commitments, periods, inflows, options, treasuryName, isAdmin,
  onEdit, onDelete, onAddCommitment, onImportCsv, onEditCommitment, onDeleteCommitment, onEditSchedule,
}: {
  slug: string;
  source: FundingSourceRow;
  summary: SourceSummary;
  commitments: FundingCommitmentRow[];
  periods: FundingPeriodRow[];
  inflows: FundingData["inflows"];
  options: readonly FundingTokenOption[];
  treasuryName: (id: string) => string;
  isAdmin: boolean;
  onEdit: () => void;
  onDelete: () => void;
  onAddCommitment: () => void;
  /** Start a schedule commitment from a release-plan CSV. */
  onImportCsv: () => void;
  onEditCommitment: (commitment: FundingCommitmentRow) => void;
  onDeleteCommitment: (commitment: FundingCommitmentRow) => void;
  onEditSchedule: (commitment: FundingCommitmentRow) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  const [showReceived, setShowReceived] = useState(false);
  const received = inflows.filter((inflow) => inflow.funding_source_id === source.id);
  const commitmentName = (id: string | null) => commitments.find((c) => c.id === id)?.name ?? null;

  return (
    <Card className="space-y-5">
      <div className="flex flex-col justify-between gap-3 sm:flex-row sm:items-start">
        <div className="min-w-0">
          <h2 className="text-lg font-semibold">{source.name}</h2>
          {source.description && <p className="mt-1 text-sm text-zinc-400">{source.description}</p>}
          {source.url && <a href={source.url} target="_blank" rel="noreferrer" className="mt-1 inline-block break-all text-xs text-indigo-400 hover:underline">{source.url}</a>}
        </div>
        {isAdmin && (
          <div className="flex shrink-0 flex-wrap gap-2">
            <Button variant="secondary" onClick={onAddCommitment}>Add commitment</Button>
            <Button variant="secondary" onClick={onImportCsv}>Import CSV</Button>
            <Button variant="ghost" onClick={onEdit}>Edit</Button>
            <Button variant="ghost" onClick={onDelete}>Delete</Button>
          </div>
        )}
      </div>

      <FundingFigures tokens={summary.tokens} options={options} label={`${source.name} totals`} />

      <div className="space-y-3">
        <h3 className="text-sm font-medium text-zinc-300">Commitments</h3>
        {commitments.length === 0 && <p className="text-sm text-zinc-500">No commitments yet. Add what this source promised to compare it with what arrived.</p>}
        {commitments.map((commitment) => {
          const figures = summary.commitments.find((c) => c.id === commitment.id);
          const expandable = commitment.kind !== "one_off";
          return (
            <div key={commitment.id} className="rounded-lg border border-zinc-800 p-4">
              <div className="flex flex-col justify-between gap-2 sm:flex-row sm:items-start">
                <div className="min-w-0">
                  <p className="text-sm font-medium">{commitment.name}</p>
                  <p className="mt-1 text-xs text-zinc-500">{describeCommitment(commitment, periods)}</p>
                  {commitment.note && <p className="mt-1 text-xs text-zinc-400">{commitment.note}</p>}
                  {commitment.url && <a href={commitment.url} target="_blank" rel="noreferrer" className="mt-1 inline-block break-all text-xs text-indigo-400 hover:underline">{commitment.url}</a>}
                </div>
                <div className="flex shrink-0 flex-wrap gap-2">
                  {expandable && (
                    <Button variant="ghost" className="text-xs" onClick={() => setOpen(open === commitment.id ? null : commitment.id)}>
                      {open === commitment.id ? "Hide periods" : "Periods"}
                    </Button>
                  )}
                  {isAdmin && commitment.kind === "schedule" && <Button variant="ghost" className="text-xs" onClick={() => onEditSchedule(commitment)}>Schedule</Button>}
                  {isAdmin && <Button variant="ghost" className="text-xs" onClick={() => onEditCommitment(commitment)}>Edit</Button>}
                  {isAdmin && <Button variant="ghost" className="text-xs" onClick={() => onDeleteCommitment(commitment)}>Remove</Button>}
                </div>
              </div>
              <div className="mt-3">
                <FundingFigures tokens={figures?.tokens ?? []} options={options} label={`${commitment.name} figures`} />
              </div>
              {open === commitment.id && figures && (
                <div className="mt-3 max-h-96 overflow-auto rounded-lg border border-zinc-800">
                  <table className="w-full text-left text-sm" aria-label={`${commitment.name} periods`}>
                    <thead className="sticky top-0 bg-[var(--option-background)] text-xs text-zinc-500">
                      <tr>
                        <th className="px-3 py-2 font-normal">Period</th>
                        <th className="px-3 py-2 font-normal">Planned</th>
                        <th className="px-3 py-2 font-normal">Received</th>
                        <th className="px-3 py-2 font-normal">Running total against the plan</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-zinc-800">
                      {figures.periods.map((period) => (
                        <tr key={period.start}>
                          <td className="whitespace-nowrap px-3 py-1">{period.label}</td>
                          <td className="px-3 py-1 font-mono text-xs">{amountsText(period.planned, options)}</td>
                          <td className="px-3 py-1 font-mono text-xs">{amountsText(period.received, options)}</td>
                          <td className="px-3 py-1">
                            <div className="flex flex-wrap gap-1">
                              {Object.entries(period.runningDifference).map(([unit, value]) => (
                                <DifferenceBadge key={unit} unit={unit} amount={value} options={options} />
                              ))}
                            </div>
                          </td>
                        </tr>
                      ))}
                      {figures.periods.length === 0 && (
                        <tr><td colSpan={4} className="px-3 py-2 text-zinc-500">No periods yet.</td></tr>
                      )}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          );
        })}
        {Object.keys(summary.unassigned).length > 0 && (
          <p className="text-sm text-zinc-400">
            Received without a commitment: <span className="font-mono">{amountsText(summary.unassigned, options)}</span>
          </p>
        )}
      </div>

      <div>
        <Button variant="ghost" className="!px-0 text-sm" onClick={() => setShowReceived((v) => !v)}>
          {showReceived ? "Hide" : "Show"} received inflows ({received.length})
        </Button>
        {showReceived && (
          <div className="mt-2 space-y-1">
            {received.length === 0 && (
              <p className="text-sm text-zinc-500">
                None yet. Tie an inflow to this source with <strong>Details</strong> on the Incoming page.
              </p>
            )}
            {received.map((inflow) => (
              <div key={inflow.tx_hash} className="flex flex-wrap justify-between gap-2 text-sm">
                <span className="text-zinc-400">
                  {inflow.block_time ? formatDate(inflow.block_time) : "Pending"} · {treasuryName(inflow.treasury_id)}
                  {commitmentName(inflow.funding_commitment_id) && ` · ${commitmentName(inflow.funding_commitment_id)}`}
                  {" · "}<span className="font-mono text-xs">{shortHash(inflow.tx_hash)}</span>
                </span>
                <span className="font-mono text-xs">
                  {[formatFundingAmount("lovelace", inflow.amount_lovelace, options),
                    ...Object.entries(inflow.assets ?? {}).map(([unit, qty]) => formatFundingAmount(unit, qty, options))].join(", ")}
                </span>
              </div>
            ))}
            <LinkButton href={routes.reconcile(slug)} variant="ghost" className="!px-0 text-sm">Open Incoming</LinkButton>
          </div>
        )}
      </div>
    </Card>
  );
}
