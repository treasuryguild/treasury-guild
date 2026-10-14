"use client";

import { MAX_PAYMENT_MEMO_BYTES } from "@/lib/constants";
import { formatUnits, plural } from "@/lib/format";
import type { BudgetLine, DraftToken } from "@/lib/payments/form";
import { Button, Card, ErrorText, Field, Input, WarningText } from "@/components/ui";

/** Totals, balance and budget checks, the memo and the build button. */
export function PaymentSummary({
  recipients, transfers, totals, tokens, overBalance, budgets, budgetsLoading, problems, memo, onMemoChange,
  canBuild, busy, error, blockedReason = null, onBuild,
}: {
  recipients: number;
  /** How many of the recipients are the community's other treasuries. */
  transfers: number;
  totals: ReadonlyMap<string, bigint>;
  tokens: DraftToken[];
  /** Tickers whose total exceeds the treasury's balance. */
  overBalance: string[];
  budgets: BudgetLine[];
  budgetsLoading: boolean;
  /** Client-side checks that stop the build. */
  problems: string[];
  memo: string;
  onMemoChange: (memo: string) => void;
  canBuild: boolean;
  busy: boolean;
  error: string | null;
  /** Why building is unavailable (wallet on the other network); disables the button. */
  blockedReason?: string | null;
  onBuild: () => void;
}) {
  const lines = tokens.filter((t) => (totals.get(t.unit) ?? 0n) > 0n)
    .map((t) => formatUnits(totals.get(t.unit)!, t.decimals, t.ticker));
  const blocked = busy || !!blockedReason || !canBuild || overBalance.length > 0 || problems.length > 0 || recipients === 0;
  const spend = recipients - transfers;

  return (
    <Card>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 flex-1">
          <p className="text-sm text-zinc-400">
            {plural(recipients, "recipient")}
            {transfers > 0 && ` · ${plural(transfers, "transfer")} between your treasuries`}
          </p>
          <p className="mt-1 text-xl font-semibold">{lines.length > 0 ? lines.join(" + ") : "Nothing entered yet"}</p>
          {budgets.length > 0 && (
            <ul className="mt-2 space-y-1 text-sm">
              {budgets.map((line) => (
                <li key={line.unit} className={line.after < 0n ? "text-amber-500" : "text-zinc-400"}>
                  Budget {line.periodLabel}: {formatUnits(line.spent, line.decimals, line.ticker)} of{" "}
                  {formatUnits(line.amount, line.decimals, line.ticker)} spent
                  {line.adding > 0n && <> · {line.after < 0n ? "over by" : "leaves"} {formatUnits(line.after < 0n ? -line.after : line.after, line.decimals, line.ticker)} after this payment</>}
                </li>
              ))}
            </ul>
          )}
          {budgets.length === 0 && !budgetsLoading && spend > 0 && (
            <p className="mt-2 text-xs text-zinc-500">
              This treasury has no budget for the chosen period. The payment is still recorded against it; set a budget on the Budgets page to track it.
            </p>
          )}
          {overBalance.length > 0 && (
            <p className="mt-1 text-sm text-red-400">Exceeds treasury balance: {overBalance.join(", ")}</p>
          )}
          {problems.length > 0 && (
            <ul className="mt-1 space-y-0.5 text-sm text-amber-500">
              {problems.map((problem) => <li key={problem}>{problem}</li>)}
            </ul>
          )}
          {tokens.length > 1 && (
            <p className="mt-1 text-xs text-zinc-500">
              Token-only outputs carry a small ADA amount (~1.2–1.5 ₳), the ledger minimum per output.
            </p>
          )}
          <Field label="Memo (optional, written on-chain)" className="mt-3 max-w-md">
            <Input value={memo} maxLength={MAX_PAYMENT_MEMO_BYTES} disabled={busy} placeholder="Invoice #12, conference sponsorship…"
              onChange={(event) => onMemoChange(event.target.value)} />
          </Field>
        </div>
        <div className="flex flex-col items-end gap-1">
          <Button onClick={onBuild} disabled={blocked} loading={busy}>
            {busy ? "Building transaction…" : "Build payment transaction"}
          </Button>
          <WarningText small>{blockedReason}</WarningText>
          {!canBuild && <WarningText small>Only admins or signers of this treasury can build payments</WarningText>}
        </div>
      </div>
      <ErrorText error={error} className="mt-3" />
    </Card>
  );
}
