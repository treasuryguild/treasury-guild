"use client";

import { Trash2 } from "lucide-react";
import { contributorLabel } from "@/lib/assignees";
import type { MemberOption } from "@/lib/boardTypes";
import type { TreasurySummary } from "@/lib/db/types";
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
  return (
    <div role="group" aria-label={label} className="grid gap-3 rounded-xl border border-[var(--border)] p-4 md:grid-cols-[10rem_minmax(0,1fr)_auto]">
      <Select aria-label={`${label} kind`} value={row.kind} disabled={disabled}
        onChange={(event) => onChange({ kind: event.target.value as RecipientKind, address: "" })}>
        {(Object.keys(KIND_LABELS) as RecipientKind[]).map((kind) => (
          <option key={kind} value={kind} disabled={kind === "treasury" && treasuries.length === 0}>{KIND_LABELS[kind]}</option>
        ))}
      </Select>
      <div className="min-w-0 space-y-2">
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
        <div className="flex flex-wrap gap-2">
          {tokens.map((token) => (
            <label key={token.unit} className="flex min-w-0 items-center gap-2 text-sm">
              <span className="w-14 shrink-0 truncate text-zinc-400" title={token.ticker}>{token.ticker}</span>
              <Input aria-label={`${label} ${token.ticker} amount`} inputMode="decimal" className="!w-36 text-right font-mono tabular-nums"
                value={row.amounts[token.unit] ?? ""} disabled={disabled || drain} placeholder="0" readOnly={drain}
                onChange={(event) => onChange({ amounts: { ...row.amounts, [token.unit]: event.target.value } })} />
            </label>
          ))}
          {tokens.length === 0 && <span className="text-xs text-zinc-500">Choose a treasury to see what it can pay.</span>}
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
      <div className="flex items-start justify-end">
        {onRemove && (
          <Button variant="ghost" className="!min-h-8 !p-1.5" aria-label={`Remove ${label.toLowerCase()}`} disabled={disabled || drain} onClick={onRemove}>
            <Trash2 className="h-4 w-4" />
          </Button>
        )}
      </div>
    </div>
  );
}
