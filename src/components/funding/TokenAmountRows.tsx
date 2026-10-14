"use client";

// Planned amounts, one row per token: pick a known token (or enter a unit)
// and type the amount in whole units, e.g. 20000 or 211800.72389063.
import { formatQuantity } from "@/lib/assets";
import type { FundingAmount } from "@/lib/db/types";
import type { FundingTokenOption } from "@/lib/funding/display";
import { Button, Input, Select } from "@/components/ui";

export interface AmountRow {
  unit: string;
  amount: string;
}

const OTHER = "__other__";

/** Stored base-unit amounts as editable rows. */
export function amountRowsFrom(amounts: readonly FundingAmount[]): AmountRow[] {
  return amounts.map((a) => ({ unit: a.unit, amount: formatQuantity(BigInt(a.amount), a.decimals) }));
}

export function TokenAmountRows({ rows, options, onChange, label }: {
  rows: AmountRow[];
  options: readonly FundingTokenOption[];
  onChange: (rows: AmountRow[]) => void;
  label: string;
}) {
  const set = (index: number, patch: Partial<AmountRow>) => onChange(rows.map((row, i) => (i === index ? { ...row, ...patch } : row)));
  return (
    <div className="space-y-2">
      {rows.map((row, index) => {
        const known = options.some((o) => o.unit === row.unit);
        return (
          <div key={index} className="flex flex-col gap-2 sm:flex-row">
            <Select aria-label={`${label} token ${index + 1}`} className="sm:max-w-48" value={known ? row.unit : OTHER}
              onChange={(e) => set(index, { unit: e.target.value === OTHER ? "" : e.target.value })}>
              {options.map((o) => <option key={o.unit} value={o.unit}>{o.ticker}</option>)}
              <option value={OTHER}>Other token…</option>
            </Select>
            {!known && (
              <Input aria-label={`${label} token unit ${index + 1}`} className="font-mono text-xs" value={row.unit}
                placeholder="policy id + asset name (hex)" spellCheck={false}
                onChange={(e) => set(index, { unit: e.target.value.trim().toLowerCase() })} />
            )}
            <Input aria-label={`${label} amount ${index + 1}`} inputMode="decimal" value={row.amount} placeholder="0"
              onChange={(e) => set(index, { amount: e.target.value.trim() })} />
            <Button variant="ghost" onClick={() => onChange(rows.filter((_, i) => i !== index))} disabled={rows.length === 1}>
              Remove
            </Button>
          </div>
        );
      })}
      <Button variant="ghost" className="!px-0 text-sm"
        onClick={() => onChange([...rows, { unit: options.find((o) => !rows.some((r) => r.unit === o.unit))?.unit ?? "", amount: "" }])}>
        Add token
      </Button>
    </div>
  );
}
