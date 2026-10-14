"use client";

import type { WalletAssetsResponse } from "@/lib/api/types";
import type { TreasurySummary } from "@/lib/db/types";
import { formatLovelace, formatUnits } from "@/lib/format";
import { tokenLabel } from "@/lib/payday/selection";
import type { WorkgroupSummary } from "@/hooks/useWorkgroups";
import { Card, Field, Select } from "@/components/ui";

export function TreasuryPicker({
  treasuries,
  workgroups,
  value,
  onChange,
  wallet,
  readyCounts,
}: {
  treasuries: TreasurySummary[];
  workgroups: WorkgroupSummary[];
  value: string;
  onChange: (treasuryId: string) => void;
  wallet: WalletAssetsResponse | null;
  /** Ready tasks each treasury may pay, once the tasks are loaded. */
  readyCounts?: ReadonlyMap<string, number>;
}) {
  const assignedByTreasury = new Map<string, string[]>();
  for (const wg of workgroups) {
    if (!wg.treasury_id) continue;
    assignedByTreasury.set(wg.treasury_id, [
      ...(assignedByTreasury.get(wg.treasury_id) ?? []),
      wg.name,
    ]);
  }

  return (
    <Card className="mb-6">
      <div className="flex flex-wrap items-end gap-4">
        <Field label="Pay from treasury" className="min-w-0 basis-full sm:min-w-64 sm:flex-1">
          <Select value={value} onChange={(e) => onChange(e.target.value)}>
            <option value="">Select…</option>
            {treasuries.map((t) => {
              const names = assignedByTreasury.get(t.id);
              const ready = readyCounts?.get(t.id);
              return (
                <option key={t.id} value={t.id}>
                  {t.name}
                  {names && names.length > 0 ? ` · ${names.join(", ")}` : ""}
                  {ready !== undefined ? ` · ${ready} ready` : ""}
                </option>
              );
            })}
          </Select>
        </Field>
        {wallet && (
          <div className="text-sm text-zinc-400">
            Balance:{" "}
            <span className="font-medium text-zinc-100">
              {formatLovelace(wallet.lovelace)}
            </span>
            {wallet.tokens.map((t) => (
              <span key={t.unit} className="ml-3 text-zinc-300">
                {formatUnits(t.quantity, t.decimals, tokenLabel(t))}
              </span>
            ))}
          </div>
        )}
      </div>
    </Card>
  );
}
