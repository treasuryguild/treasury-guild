"use client";

import Link from "next/link";
import { ArrowDownLeft } from "lucide-react";
import { formatUnitAmount, type UnitDisplay } from "@/lib/assetRegistry";
import type { BudgetIncomingItem } from "@/lib/api/types";
import { LOVELACE } from "@/lib/assets";
import { formatDate, shortHash } from "@/lib/format";
import { Badge, Card, EmptyState } from "@/components/ui";

/** Recent treasury inflows and their reconciliation status. */
export function IncomingPanel({ items, display, loading, manageHref }: {
  items: BudgetIncomingItem[];
  display: UnitDisplay;
  loading: boolean;
  manageHref: string;
}) {
  return (
    <section className="min-w-0">
      <div className="mb-3 flex items-center justify-between gap-3">
        <h2 className="text-lg font-semibold">Incoming</h2>
        <Link href={manageHref} className="text-sm font-medium text-indigo-400 hover:underline">Manage</Link>
      </div>
      <Card className="overflow-hidden !p-0">
        <div className="divide-y divide-zinc-800">
          {items.map((item) => (
            <div key={item.txHash} className="px-5 py-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0">
                  <p className="flex items-center gap-2 text-sm font-medium">
                    <ArrowDownLeft className="h-4 w-4 text-emerald-400" />
                    {formatUnitAmount(LOVELACE, item.amountLovelace, display)}
                  </p>
                  <p className="mt-1 truncate font-mono text-xs text-zinc-500">{shortHash(item.txHash)}</p>
                </div>
                <Badge tone={!item.requiresReconciliation || item.matched ? "green" : "yellow"}>
                  {!item.requiresReconciliation ? "logged" : item.matched ? "reconciled" : "review"}
                </Badge>
              </div>
              <p className="mt-2 text-xs text-zinc-500">
                <span className="capitalize">{item.fromTreasuryName ? "transfer" : item.incomingType}</span>
                {" · "}{item.fromTreasuryName ? `${item.fromTreasuryName} → ${item.treasuryName}` : item.treasuryName}
                {item.blockTime ? ` · ${formatDate(item.blockTime)}` : ""}
              </p>
            </div>
          ))}
          {!loading && items.length === 0 && (
            <div className="p-5"><EmptyState card={false}>No incoming transactions.</EmptyState></div>
          )}
        </div>
      </Card>
    </section>
  );
}
