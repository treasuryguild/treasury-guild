"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { StakePoolSummary, StakePoolsResponse } from "@/lib/api/types";
import { formatLovelace, shortAddress } from "@/lib/format";
import { useAsyncData } from "@/hooks/useAsyncData";
import { Button, ErrorText, Field, Input } from "@/components/ui";

const SEARCH_DEBOUNCE_MS = 300;

function formatMargin(margin: number | null): string {
  if (margin == null) return "—";
  return `${(margin * 100).toFixed(1)}%`;
}

/** Searchable stake-pool list for the Staking page (Koios via /api/chain/stake-pools). */
export function StakePoolPicker({
  treasuryId,
  value,
  onChange,
  disabled,
}: {
  treasuryId: string;
  value: string;
  onChange: (poolId: string) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selected, setSelected] = useState<StakePoolSummary | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setDebounced(query.trim()), SEARCH_DEBOUNCE_MS);
    return () => clearTimeout(t);
  }, [query]);

  // Keep the selected chip in sync when the parent prefills (current delegation)
  // or when the user pastes a raw id that is not in the result list.
  useEffect(() => {
    const trimmed = value.trim();
    if (!trimmed) {
      setSelected(null);
      return;
    }
    setSelected((prev) =>
      prev && prev.poolId === trimmed
        ? prev
        : { poolId: trimmed, ticker: null, margin: null, fixedCost: null, activeStake: null, status: "registered" },
    );
  }, [value]);

  const pools = useAsyncData(
    `stake-pools:${treasuryId}:${debounced}`,
    async () => {
      const params = new URLSearchParams({ treasuryId });
      if (debounced) params.set("q", debounced);
      return apiFetch<StakePoolsResponse>(`/api/chain/stake-pools?${params}`);
    },
  );

  function pick(pool: StakePoolSummary) {
    setSelected(pool);
    onChange(pool.poolId);
  }

  function clear() {
    setSelected(null);
    onChange("");
  }

  const list = pools.data?.pools ?? [];

  return (
    <div className="space-y-3">
      {selected && value.trim() && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-zinc-500">Selected</span>
          <span className="font-medium">{selected.ticker ?? "Pool"}</span>
          <code className="font-mono text-xs">{shortAddress(selected.poolId)}</code>
          <Button type="button" variant="ghost" disabled={disabled} onClick={clear}>
            Clear
          </Button>
        </div>
      )}

      <Field label="Search pools" hint="Ticker or pool id — browse the list or type to filter">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="e.g. NUTS or pool1…"
          disabled={disabled}
          autoComplete="off"
        />
      </Field>

      {pools.error && <ErrorText error={pools.error} />}
      {pools.loading && !pools.data && (
        <p className="text-sm text-zinc-500">Loading pools…</p>
      )}

      <ul
        className="max-h-56 overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-900/40"
        role="listbox"
        aria-label="Stake pools"
      >
        {list.length === 0 && !pools.loading && (
          <li className="px-3 py-2 text-sm text-zinc-500">No pools matched</li>
        )}
        {list.map((pool) => {
          const active = value.trim() === pool.poolId;
          return (
            <li key={pool.poolId} className="border-b border-zinc-700 last:border-b-0">
              <button
                type="button"
                role="option"
                aria-selected={active}
                disabled={disabled}
                onClick={() => pick(pool)}
                className={`flex w-full items-start gap-3 px-3 py-2 text-left text-sm text-zinc-100 hover:bg-zinc-800 disabled:opacity-50 ${
                  active ? "bg-indigo-950/20" : ""
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{pool.ticker ?? "—"}</span>
                  <span className="mt-0.5 block font-mono text-xs text-zinc-500">
                    {shortAddress(pool.poolId)}
                  </span>
                </span>
                <span className="shrink-0 text-right text-xs text-zinc-500">
                  <span className="block">fee {formatMargin(pool.margin)}</span>
                  <span className="block">
                    {pool.activeStake
                      ? formatLovelace(BigInt(pool.activeStake))
                      : "—"}
                  </span>
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <Field label="Or paste a pool id" hint="pool1… or 56-character hex">
        <Input
          className="font-mono text-xs"
          value={value}
          onChange={(e) => {
            setSelected(null);
            onChange(e.target.value);
          }}
          placeholder="pool1…"
          disabled={disabled}
        />
      </Field>
    </div>
  );
}
