"use client";

import { formatUnitAmount, type UnitDisplay } from "@/lib/assetRegistry";
import type { BudgetSpendingItem } from "@/lib/api/types";
import { PayoutStatus } from "@/lib/constants";
import { formatDate } from "@/lib/format";
import { Badge, Card, EmptyState } from "@/components/ui";

const MAX_ITEMS = 20;

/**
 * The latest spend lines in view: a task payout (task, workgroup), a manual
 * payment (recipient, treasury) or a line imported from a previous wallet
 * (task, workgroup), with attributed date, status and amount.
 */
export function SpendingDetailList({ items, display, loading }: {
  items: BudgetSpendingItem[];
  display: UnitDisplay;
  loading: boolean;
}) {
  return (
    <section className="min-w-0">
      <h2 className="mb-3 text-lg font-semibold">Spending detail</h2>
      <Card className="overflow-hidden !p-0">
        <div className="divide-y divide-zinc-800">
          {items.slice(0, MAX_ITEMS).map((item) => (
            <div key={`${item.kind}:${item.id}`} className="flex flex-col justify-between gap-2 px-5 py-4 sm:flex-row sm:items-center">
              <div className="min-w-0">
                <p className="truncate text-sm font-medium">
                  {item.title}
                  {item.kind === "payment" && <span className="ml-2 text-xs font-normal text-zinc-500">Payment</span>}
                  {item.kind === "legacy" && <span className="ml-2 text-xs font-normal text-zinc-500">Previous wallet</span>}
                </p>
                <p className="mt-1 text-xs text-zinc-500">
                  {item.ownerName} · {formatDate(item.createdAt)}
                </p>
              </div>
              <div className="flex items-center gap-2 sm:justify-end">
                <Badge tone={item.kind === "legacy" || item.status === PayoutStatus.Confirmed || item.status === PayoutStatus.WrittenBack ? "green" : "blue"}>
                  {item.status.replace("_", " ")}
                </Badge>
                <span className="font-mono text-sm">−{formatUnitAmount(item.unit, item.amount, display)}</span>
              </div>
            </div>
          ))}
          {!loading && items.length === 0 && (
            <div className="p-5"><EmptyState card={false}>No spending in the current view.</EmptyState></div>
          )}
        </div>
      </Card>
    </section>
  );
}
