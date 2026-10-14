"use client";

// One muted line under a transaction list: whether the on-visit chain check
// is running and when the treasuries were last polled (useChainSync).
import type { ChainSyncState } from "@/hooks/useChainSync";
import { formatDate } from "@/lib/format";

export function ChainSyncStatus({
  checking,
  lastSyncedAt,
  error,
  className = "",
}: ChainSyncState & { className?: string }) {
  let text: string;
  if (checking) text = "Checking chain…";
  else if (error) text = `Chain check failed: ${error}`;
  else if (lastSyncedAt) text = `Chain checked ${formatDate(lastSyncedAt, "datetime")}`;
  else text = "Chain not checked yet";
  return (
    <p
      className={`text-xs ${error && !checking ? "text-amber-400" : "text-zinc-500"} ${className}`}
      aria-live="polite"
    >
      {text}
    </p>
  );
}
