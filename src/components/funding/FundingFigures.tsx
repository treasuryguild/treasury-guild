"use client";

// Planned / due / received / difference / still to receive, one row per token.
import type { FundingTokenOption } from "@/lib/funding/display";
import { formatFundingAmount } from "@/lib/funding/display";
import type { TokenFigures } from "@/lib/funding/plan";
import { Badge } from "@/components/ui";

export function DifferenceBadge({ unit, amount, options }: { unit: string; amount: string; options: readonly FundingTokenOption[] }) {
  const value = BigInt(amount);
  if (value === 0n) return <Badge tone="green">On plan</Badge>;
  const text = formatFundingAmount(unit, (value < 0n ? -value : value).toString(), options);
  return value > 0n ? <Badge tone="blue">{text} over</Badge> : <Badge tone="yellow">{text} under</Badge>;
}

export function FundingFigures({ tokens, options, label }: {
  tokens: readonly TokenFigures[];
  options: readonly FundingTokenOption[];
  label: string;
}) {
  if (tokens.length === 0) return <p className="text-sm text-zinc-500">Nothing planned or received yet.</p>;
  const amount = (unit: string, value: string | null) => (value === null ? "Open-ended" : formatFundingAmount(unit, value, options));
  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left text-sm" aria-label={label}>
        <thead className="text-xs text-zinc-500">
          <tr>
            <th className="py-1 pr-3 font-normal">Planned</th>
            <th className="py-1 pr-3 font-normal">Due so far</th>
            <th className="py-1 pr-3 font-normal">Received</th>
            <th className="py-1 pr-3 font-normal">Against the plan</th>
            <th className="py-1 font-normal">Still to receive</th>
          </tr>
        </thead>
        <tbody>
          {tokens.map((t) => (
            <tr key={t.unit} className="align-top">
              <td className="py-1 pr-3 font-mono text-xs">{amount(t.unit, t.planned)}</td>
              <td className="py-1 pr-3 font-mono text-xs">{amount(t.unit, t.due)}</td>
              <td className="py-1 pr-3 font-mono text-xs">{amount(t.unit, t.received)}</td>
              <td className="py-1 pr-3"><DifferenceBadge unit={t.unit} amount={t.difference} options={options} /></td>
              <td className="py-1 font-mono text-xs">
                {t.remaining === null ? "Open-ended" : BigInt(t.remaining) <= 0n ? "Nothing" : amount(t.unit, t.remaining)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
