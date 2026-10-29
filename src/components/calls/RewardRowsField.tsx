"use client";

import { Trash2 } from "lucide-react";
import type { AmountRow } from "@/lib/boardTypes";
import { Button, Field, Input, Select } from "@/components/ui";

const CUSTOM = "__custom__";

/** A reward as ticker / amount rows: a call's or linked meeting's per attendee, or a proposed task's bounty. */
export function RewardRowsField({
  rows,
  onChange,
  tickers,
  locked = false,
  label = "Reward per attendee",
  hint = "Add tokens the paying wallet holds; Custom… is matched to a treasury token at payout. Every rewarded attendee receives the full amount.",
}: {
  rows: AmountRow[];
  onChange: (rows: AmountRow[]) => void;
  /** Known tickers (ADA first). Unused ones appear under Add token… */
  tickers: readonly string[];
  /** Attendance tasks already carry the reward. */
  locked?: boolean;
  label?: string;
  hint?: string;
}) {
  const known = new Set(tickers.map((t) => t.toLowerCase()));
  const used = new Set(rows.map((r) => r.ticker.trim().toLowerCase()).filter(Boolean));
  const available = tickers.filter((t) => !used.has(t.toLowerCase()));

  const setRow = (index: number, patch: Partial<AmountRow>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  return (
    <Field
      label={label}
      hint={locked ? "Locked: attendance tasks already carry this reward." : hint}
    >
      <div className="space-y-2">
        {rows.map((row, i) => {
          const custom = !row.ticker.trim() || !known.has(row.ticker.trim().toLowerCase());
          return (
            <div key={i} className="flex min-w-0 items-center gap-2">
              {custom ? (
                <Input aria-label={`Reward ${i + 1} ticker`} className="!w-32" value={row.ticker} placeholder="TICKER"
                  disabled={locked} onChange={(e) => setRow(i, { ticker: e.target.value })} />
              ) : (
                <span className="w-14 shrink-0 truncate text-sm text-zinc-400" title={row.ticker}>{row.ticker}</span>
              )}
              <Input aria-label={`Reward ${i + 1} amount`} inputMode="decimal" className="!w-36 text-right font-mono tabular-nums"
                value={row.amount} placeholder="0" disabled={locked}
                onChange={(e) => setRow(i, { amount: e.target.value })} />
              {!locked && (
                <Button type="button" variant="ghost" className="!min-h-8 !p-1.5" aria-label={`Remove reward ${i + 1}`}
                  onClick={() => onChange(rows.filter((_, j) => j !== i))}>
                  <Trash2 className="h-4 w-4" />
                </Button>
              )}
            </div>
          );
        })}
        {!locked && (
          <Select aria-label="Add token" value=""
            onChange={(e) => {
              const value = e.target.value;
              if (!value) return;
              if (value === CUSTOM) onChange([...rows, { ticker: "", amount: "" }]);
              else onChange([...rows, { ticker: value, amount: "" }]);
            }}>
            <option value="">+ Add token…</option>
            {available.map((ticker) => (
              <option key={ticker} value={ticker}>{ticker}</option>
            ))}
            <option value={CUSTOM}>Custom…</option>
          </Select>
        )}
      </div>
    </Field>
  );
}
