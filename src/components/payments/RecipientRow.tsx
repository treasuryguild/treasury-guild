"use client";

import { Trash2 } from "lucide-react";
import { contributorLabel } from "@/lib/assignees";
import type { MemberOption } from "@/lib/boardTypes";
import type { TreasurySummary } from "@/lib/db/types";
import { shortUnit } from "@/lib/format";
import type { DraftToken, RecipientDraft, RecipientKind } from "@/lib/payments/form";
import { Button, Input, Select } from "@/components/ui";

const KIND_LABELS: Record<RecipientKind, string> = {
  member: "Community member",
  treasury: "Another treasury",
  address: "Any address",
};

/** One recipient of a payment: who (member, sibling treasury or typed address) and how much per token. */
export function RecipientRow({
  row, index, members, treasuries, tokens, disabled, drain, canDrain, onChange, onRemove, onDrain, onClearDrain,
}: {
  row: RecipientDraft;
  index: number;
  members: MemberOption[];
  /** The community's other treasuries (the paying one excluded). */
  treasuries: TreasurySummary[];
  tokens: DraftToken[];
  disabled: boolean;
  /** Every held asset is being moved; amounts are a preview (fee comes from ADA at build). */
  drain: boolean;
  /** Wallet has assets and this row has a recipient address. */
  canDrain: boolean;
  onChange: (patch: Partial<RecipientDraft>) => void;
  onRemove?: () => void;
  onDrain: () => void;
  onClearDrain: () => void;
}) {
  const label = `Recipient ${index + 1}`;
  const known = new Set(tokens.map((token) => token.unit));
  const added = [
    ...tokens.filter((token) => token.unit in row.amounts),
    ...Object.keys(row.amounts)
      .filter((unit) => !known.has(unit))
      .map((unit) => ({ unit, ticker: shortUnit(unit), decimals: 0, held: 0n })),
  ];
  const available = tokens.filter((token) => !(token.unit in row.amounts));

  function setAmount(unit: string, amount: string) {
    onChange({ amounts: { ...row.amounts, [unit]: amount } });
  }

  function removeAmount(unit: string) {
    const next = { ...row.amounts };
    delete next[unit];
    onChange({ amounts: next });
  }

  return (
    <div role="group" aria-label={label} className="rounded-xl border border-[var(--border)] p-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start">
        <div className="w-full shrink-0 sm:w-52">
          <Select aria-label={`${label} kind`} value={row.kind} disabled={disabled}
            onChange={(event) => onChange({ kind: event.target.value as RecipientKind, address: "" })}>
            {(Object.keys(KIND_LABELS) as RecipientKind[]).map((kind) => (
              <option key={kind} value={kind} disabled={kind === "treasury" && treasuries.length === 0}>{KIND_LABELS[kind]}</option>
            ))}
          </Select>
        </div>
        <div className="min-w-0 flex-1 space-y-2">
          {row.kind === "member" && (
            <Select aria-label={`${label} member`} value={row.address} disabled={disabled}
              onChange={(event) => onChange({ address: event.target.value })}>
              <option value="">Choose a member…</option>
              {members.map((member) => (
                <option key={member.wallet} value={member.wallet}>{contributorLabel(member)}</option>
              ))}
            </Select>
          )}
          {row.kind === "treasury" && (
            <Select aria-label={`${label} treasury`} value={row.address} disabled={disabled}
              onChange={(event) => onChange({ address: event.target.value })}>
              <option value="">Choose a treasury…</option>
              {treasuries.map((treasury) => (
                <option key={treasury.id} value={treasury.address}>{treasury.name}</option>
              ))}
            </Select>
          )}
          {row.kind === "address" && (
            <Input aria-label={`${label} address`} className="font-mono text-xs" value={row.address} disabled={disabled}
              placeholder="addr…" spellCheck={false}
              onChange={(event) => onChange({ address: event.target.value })} />
          )}
          <div className="space-y-2">
            {added.map((token) => (
              <div key={token.unit} className="flex min-w-0 items-center gap-2 text-sm">
                <span className="w-14 shrink-0 truncate text-zinc-400" title={token.ticker}>{token.ticker}</span>
                <Input aria-label={`${label} ${token.ticker} amount`} inputMode="decimal" className="!w-36 text-right font-mono tabular-nums"
                  value={row.amounts[token.unit] ?? ""} disabled={disabled || drain} placeholder="0" readOnly={drain}
                  onChange={(event) => setAmount(token.unit, event.target.value)} />
                {!drain && (
                  <Button type="button" variant="ghost" className="!min-h-8 !p-1.5" aria-label={`Remove ${token.ticker}`}
                    disabled={disabled} onClick={() => removeAmount(token.unit)}>
                    <Trash2 className="h-4 w-4" />
                  </Button>
                )}
              </div>
            ))}
            {tokens.length === 0 && (
              <span className="text-xs text-zinc-500">Choose a treasury to see what it can pay.</span>
            )}
            {!drain && available.length > 0 && (
              <Select aria-label={`${label} add asset`} value="" disabled={disabled}
                onChange={(event) => {
                  const unit = event.target.value;
                  if (unit) setAmount(unit, "");
                }}>
                <option value="">+ Add asset…</option>
                {available.map((token) => (
                  <option key={token.unit} value={token.unit}>{token.ticker}</option>
                ))}
              </Select>
            )}
          </div>
          {drain ? (
            <div className="flex flex-wrap items-center gap-2">
              <p className="text-xs text-zinc-500">
                Moving every asset this treasury holds. The network fee is taken from ADA at build time; the paying wallet is left empty.
              </p>
              <Button type="button" variant="secondary" className="!min-h-8 shrink-0" disabled={disabled} onClick={onClearDrain}>
                Edit amounts
              </Button>
            </div>
          ) : (
            <Button type="button" variant="secondary" className="!min-h-8" disabled={disabled || !canDrain} onClick={onDrain}>
              Move all assets
            </Button>
          )}
        </div>
        {onRemove && (
          <Button variant="ghost" className="!min-h-8 !p-1.5 self-end sm:self-start" aria-label={`Remove ${label.toLowerCase()}`} disabled={disabled || drain} onClick={onRemove}>
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
