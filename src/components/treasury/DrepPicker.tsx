"use client";

import { useEffect, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { DrepSummary, DrepsResponse } from "@/lib/api/types";
import {
  DREP_ALWAYS_ABSTAIN,
  DREP_ALWAYS_NO_CONFIDENCE,
  isSpecialDrepId,
} from "@/lib/cardano/dreps";
import { formatLovelace, shortAddress } from "@/lib/format";
import { useAsyncData } from "@/hooks/useAsyncData";
import { Button, ErrorText, Field, Input } from "@/components/ui";

const SEARCH_DEBOUNCE_MS = 300;

const SPECIAL_OPTIONS: { id: string; label: string }[] = [
  { id: DREP_ALWAYS_ABSTAIN, label: "Always abstain" },
  { id: DREP_ALWAYS_NO_CONFIDENCE, label: "Always no confidence" },
];

function specialLabel(id: string): string | null {
  return SPECIAL_OPTIONS.find((o) => o.id === id)?.label ?? null;
}

/** Searchable DRep list for the Staking page (Koios via /api/chain/dreps). */
export function DrepPicker({
  treasuryId,
  value,
  onChange,
  disabled,
}: {
  treasuryId: string;
  value: string;
  onChange: (dRepId: string) => void;
  disabled?: boolean;
}) {
  const [query, setQuery] = useState("");
  const [debounced, setDebounced] = useState("");
  const [selected, setSelected] = useState<DrepSummary | null>(null);

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
    if (isSpecialDrepId(trimmed)) {
      setSelected({
        dRepId: trimmed,
        givenName: specialLabel(trimmed),
        votingPower: null,
        registered: true,
        hasScript: false,
      });
      return;
    }
    setSelected((prev) =>
      prev && prev.dRepId === trimmed
        ? prev
        : {
            dRepId: trimmed,
            givenName: null,
            votingPower: null,
            registered: true,
            hasScript: false,
          },
    );
  }, [value]);

  const dreps = useAsyncData(
    `dreps:${treasuryId}:${debounced}`,
    async () => {
      const params = new URLSearchParams({ treasuryId });
      if (debounced) params.set("q", debounced);
      return apiFetch<DrepsResponse>(`/api/chain/dreps?${params}`);
    },
  );

  function pick(drep: DrepSummary) {
    setSelected(drep);
    onChange(drep.dRepId);
  }

  function pickSpecial(id: string) {
    setSelected({
      dRepId: id,
      givenName: specialLabel(id),
      votingPower: null,
      registered: true,
      hasScript: false,
    });
    onChange(id);
  }

  function clear() {
    setSelected(null);
    onChange("");
  }

  const list = dreps.data?.dreps ?? [];
  const trimmedValue = value.trim();

  return (
    <div className="space-y-3">
      {selected && trimmedValue && (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-zinc-500">Selected</span>
          <span className="font-medium">
            {selected.givenName ?? specialLabel(trimmedValue) ?? "DRep"}
          </span>
          {!isSpecialDrepId(trimmedValue) && (
            <code className="font-mono text-xs">{shortAddress(selected.dRepId)}</code>
          )}
          <Button type="button" variant="ghost" disabled={disabled} onClick={clear}>
            Clear
          </Button>
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {SPECIAL_OPTIONS.map((opt) => {
          const active = trimmedValue === opt.id;
          return (
            <Button
              key={opt.id}
              type="button"
              variant={active ? "primary" : "secondary"}
              disabled={disabled}
              onClick={() => pickSpecial(opt.id)}
            >
              {opt.label}
            </Button>
          );
        })}
      </div>

      <Field label="Search DReps" hint="Name or drep id — browse the list or type to filter">
        <Input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="e.g. Team Drep or drep1…"
          disabled={disabled}
          autoComplete="off"
        />
      </Field>

      {dreps.error && <ErrorText error={dreps.error} />}
      {dreps.loading && !dreps.data && (
        <p className="text-sm text-zinc-500">Loading DReps…</p>
      )}

      <ul
        className="max-h-56 overflow-y-auto rounded-xl border border-zinc-700 bg-zinc-900/40"
        role="listbox"
        aria-label="DReps"
      >
        {list.length === 0 && !dreps.loading && (
          <li className="px-3 py-2 text-sm text-zinc-500">No DReps matched</li>
        )}
        {list.map((drep) => {
          const active = trimmedValue === drep.dRepId;
          return (
            <li key={drep.dRepId} className="border-b border-zinc-700 last:border-b-0">
              <button
                type="button"
                role="option"
                aria-selected={active}
                disabled={disabled}
                onClick={() => pick(drep)}
                className={`flex w-full items-start gap-3 px-3 py-2 text-left text-sm text-zinc-100 hover:bg-zinc-800 disabled:opacity-50 ${
                  active ? "bg-indigo-950/20" : ""
                }`}
              >
                <span className="min-w-0 flex-1">
                  <span className="font-medium">{drep.givenName ?? "—"}</span>
                  <span className="mt-0.5 block font-mono text-xs text-zinc-500">
                    {shortAddress(drep.dRepId)}
                  </span>
                </span>
                <span className="shrink-0 text-right text-xs text-zinc-500">
                  {drep.votingPower
                    ? formatLovelace(BigInt(drep.votingPower))
                    : "—"}
                </span>
              </button>
            </li>
          );
        })}
      </ul>

      <Field label="Or paste a DRep id" hint="drep1… or 56-character hex">
        <Input
          className="font-mono text-xs"
          value={isSpecialDrepId(trimmedValue) ? "" : value}
          onChange={(e) => {
            setSelected(null);
            onChange(e.target.value);
          }}
          placeholder="drep1…"
          disabled={disabled}
        />
      </Field>
    </div>
  );
}
