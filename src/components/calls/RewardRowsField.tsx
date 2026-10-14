"use client";

import { Plus, Trash2 } from "lucide-react";
import type { AmountRow } from "@/lib/boardTypes";
import { Button, Field, Input } from "@/components/ui";

/** A reward as ticker / amount rows: a call's or linked meeting's per attendee, or a proposed task's bounty. */
export function RewardRowsField({
  rows,
  onChange,
  locked = false,
  label = "Reward per attendee",
  hint = "Every rewarded attendee receives the full amount. A ticker is matched to a treasury token at payout.",
}: {
  rows: AmountRow[];
  onChange: (rows: AmountRow[]) => void;
  /** Attendance tasks already carry the reward. */
  locked?: boolean;
  label?: string;
  hint?: string;
}) {
  const setRow = (index: number, patch: Partial<AmountRow>) =>
    onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));

  return (
    <Field
      label={label}
      hint={locked ? "Locked: attendance tasks already carry this reward." : hint}
    >
      <div className="space-y-2">
        {rows.map((row, i) => (
          <div key={i} className="flex items-center gap-2">
            <Input aria-label={`Reward ${i + 1} ticker`} className="!w-32" value={row.ticker} placeholder="ADA"
              disabled={locked} onChange={(e) => setRow(i, { ticker: e.target.value })} />
            <Input aria-label={`Reward ${i + 1} amount`} inputMode="decimal" className="text-right font-mono tabular-nums"
              value={row.amount} placeholder="0" disabled={locked}
              onChange={(e) => setRow(i, { amount: e.target.value })} />
            {rows.length > 1 && !locked && (
              <Button variant="ghost" className="!min-h-8 !p-1.5" aria-label={`Remove reward ${i + 1}`}
                onClick={() => onChange(rows.filter((_, j) => j !== i))}>
                <Trash2 className="h-4 w-4" />
              </Button>
            )}
          </div>
        ))}
        {!locked && (
          <Button variant="ghost" onClick={() => onChange([...rows, { ticker: "", amount: "" }])}>
            <Plus className="h-4 w-4" />Add token
          </Button>
        )}
      </div>
    </Field>
  );
}
