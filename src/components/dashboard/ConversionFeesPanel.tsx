"use client";

import Link from "next/link";
import type { DashboardConversionFee } from "@/lib/api/types";
import { Card, EmptyState } from "@/components/ui";

/** Bridge/swap fee totals for the selected dashboard window (not budget spend). */
export function ConversionFeesPanel({
  fees,
  loading,
  manageHref,
}: {
  fees: DashboardConversionFee[];
  loading: boolean;
  manageHref: string;
}) {
  return (
    <section className="min-w-0">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Conversion fees</h2>
        <Link href={manageHref} className="text-sm font-medium text-indigo-400 hover:underline">
          Incoming
        </Link>
      </div>
      <Card>
        {loading && fees.length === 0 && <p className="text-sm text-zinc-500">Loading…</p>}
        {!loading && fees.length === 0 && (
          <EmptyState>No bridge or swap fees recorded in this period.</EmptyState>
        )}
        {fees.length > 0 && (
          <ul className="space-y-2">
            {fees.map((fee) => (
              <li key={`${fee.assetLabel}:${fee.chain ?? ""}`} className="flex justify-between gap-3 text-sm">
                <span className="text-zinc-400">
                  {fee.assetLabel}{fee.chain ? ` · ${fee.chain}` : ""}
                </span>
                <span className="font-medium tabular-nums">{fee.amount} {fee.assetLabel}</span>
              </li>
            ))}
          </ul>
        )}
        <p className="mt-3 text-xs text-zinc-500">
          Ops costs of bridges and swaps — not charged to workgroup budgets.
        </p>
      </Card>
    </section>
  );
}
