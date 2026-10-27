"use client";

import type { WalletAssetsResponse } from "@/lib/api/types";
import { MAX_PAYOUT_CONTRIBUTORS, TOKEN_CONTRIBUTOR_WARNING } from "@/lib/constants";
import type { PaydayMatching } from "@/lib/payday/matching";
import { describeTotals, type PaydaySummary } from "@/lib/payday/summary";
import { Button, Card, ErrorText, WarningText } from "@/components/ui";
import { TokenConnector } from "./TokenConnector";

/** What the payout leaves out, each linking to the view that lists it. */
export interface PayoutCoverage {
  attention: number;
  unticked: number;
  elsewhere: number;
  /** Selected tasks a filter hides: included, just not listed. */
  hiddenSelected: number;
}

export type CoverageTarget = "attention" | "unticked" | "elsewhere" | "all";

export function PayoutSummary({
  summary,
  matching,
  wallet,
  treasuryId,
  connections,
  onConnectionsChange,
  overBudgetFields,
  canBuild,
  busy,
  error,
  blockedReason = null,
  coverage,
  onShow,
  onBuild,
}: {
  summary: PaydaySummary;
  matching: PaydayMatching;
  wallet: WalletAssetsResponse | null;
  treasuryId: string;
  connections: Record<string, string>;
  onConnectionsChange: (next: Record<string, string>) => void;
  overBudgetFields: string[];
  canBuild: boolean;
  busy: boolean;
  error: string | null;
  /** Why building is unavailable (wallet on the other network); disables the button. */
  blockedReason?: string | null;
  coverage: PayoutCoverage;
  onShow: (target: CoverageTarget) => void;
  onBuild: () => void;
}) {
  const overBudget = overBudgetFields.length > 0;
  const blocked =
    busy ||
    !!blockedReason ||
    !treasuryId ||
    !canBuild ||
    overBudget ||
    summary.tooManyContributors ||
    matching.unresolved.length > 0 ||
    summary.count === 0;

  return (
    <Card>
      <div className="flex flex-wrap items-center justify-between gap-4">
        <div>
          <p className="text-sm text-zinc-400">
            {summary.count} tasks → {summary.payments} payments →{" "}
            {summary.wallets.size} contributors
          </p>
          <p className="mt-1 text-xl font-semibold">{describeTotals(summary.totals)}</p>
          <CoverageLine coverage={coverage} onShow={onShow} />
          {treasuryId && wallet && (
            <TokenConnector
              matching={matching}
              tokens={wallet.tokens}
              connections={connections}
              onChange={onConnectionsChange}
            />
          )}
          {matching.unresolved.length > 0 && (
            <WarningText className="mt-1">
              Connect a wallet token for: {matching.unresolved.join(", ")}
            </WarningText>
          )}
          {overBudget && (
            <p className="mt-1 text-sm text-red-400">
              Exceeds treasury balance: {overBudgetFields.join(", ")}
            </p>
          )}
          {summary.tooManyContributors && (
            <p className="mt-1 text-sm text-red-400">
              Max {MAX_PAYOUT_CONTRIBUTORS} contributors per batch (tx size limit)
              — split into two payouts
            </p>
          )}
          {!summary.tooManyContributors && summary.contributorWarning && (
            <WarningText className="mt-1">
              Token payouts make transactions larger — over{" "}
              {TOKEN_CONTRIBUTOR_WARNING} contributors may exceed the tx size
              limit; consider splitting the batch
            </WarningText>
          )}
          {summary.hasTokens && (
            <p className="mt-1 text-xs text-zinc-500">
              Token-only payouts carry a small ADA amount (~1.2–1.5 ₳) — the
              ledger minimum per output
            </p>
          )}
        </div>
        <div className="flex flex-col items-end gap-1">
          <Button onClick={onBuild} disabled={blocked} loading={busy}>
            {busy ? "Building transaction…" : "Build payout transaction"}
          </Button>
          <WarningText small>{blockedReason}</WarningText>
          {!canBuild && summary.count > 0 && (
            <WarningText small>
              Only signers of this treasury, or leads of all selected workgroups, can
              build payouts
            </WarningText>
          )}
        </div>
      </div>
      <ErrorText error={error} className="mt-3" />
    </Card>
  );
}

function CoverageLine({ coverage, onShow }: { coverage: PayoutCoverage; onShow: (target: CoverageTarget) => void }) {
  const left = [
    { target: "attention" as const, n: coverage.attention, label: "need attention" },
    { target: "unticked" as const, n: coverage.unticked, label: "unticked" },
    { target: "elsewhere" as const, n: coverage.elsewhere, label: "paid from other treasuries" },
  ].filter((x) => x.n > 0);
  return (
    <>
      {left.length > 0 && (
        <p className="mt-1 text-xs text-zinc-500">
          Not included:{" "}
          {left.map((x, i) => (
            <span key={x.target}>
              {i > 0 && " · "}
              <button type="button" className="underline hover:text-zinc-300" onClick={() => onShow(x.target)}>
                {x.n} {x.label}
              </button>
            </span>
          ))}
        </p>
      )}
      {coverage.hiddenSelected > 0 && (
        <WarningText small className="mt-1">
          {coverage.hiddenSelected} selected {coverage.hiddenSelected === 1 ? "task is" : "tasks are"} hidden
          by the filters and still included.{" "}
          <button type="button" className="underline" onClick={() => onShow("all")}>
            Show all
          </button>
        </WarningText>
      )}
    </>
  );
}
