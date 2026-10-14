"use client";

import type { WalletTokenWire } from "@/lib/api/types";
import { formatUnits } from "@/lib/format";
import type { PaydayMatching } from "@/lib/payday/matching";
import { tokenLabel } from "@/lib/payday/selection";
import { Select } from "@/components/ui";

/** Manual field -> wallet-token connections for fields the matcher couldn't resolve. */
export function TokenConnector({
  matching,
  tokens,
  connections,
  onChange,
}: {
  matching: PaydayMatching;
  tokens: WalletTokenWire[];
  connections: Record<string, string>;
  onChange: (next: Record<string, string>) => void;
}) {
  if (matching.needsPick.size === 0) return null;

  function setConnection(field: string, unit: string) {
    const next = { ...connections };
    if (unit) next[field] = unit;
    else delete next[field];
    onChange(next);
  }

  return (
    <div className="mt-3 space-y-2">
      {[...matching.needsPick.entries()].map(([field, candidates]) => {
        const options = candidates ?? tokens;
        const picked = tokens.find((t) => t.unit === connections[field]);
        const reason = matching.stale.includes(field)
          ? " — mapped token not in this wallet"
          : candidates
            ? " — several tokens share this ticker"
            : " — no matching token in this wallet";
        return (
          <div key={field} className="flex flex-wrap items-center gap-2 text-sm">
            <span className="text-amber-500">
              {field}
              {reason}
            </span>
            <Select
              value={connections[field] ?? ""}
              onChange={(e) => setConnection(field, e.target.value)}
            >
              <option value="">Connect a token…</option>
              {options.map((t) => (
                <option key={t.unit} value={t.unit}>
                  {tokenLabel(t)} · {formatUnits(t.quantity, t.decimals)}
                </option>
              ))}
            </Select>
            {picked && picked.source === "none" && (
              <span className="text-xs text-zinc-500">
                {picked.decimals} decimals — registry metadata missing
              </span>
            )}
          </div>
        );
      })}
    </div>
  );
}
