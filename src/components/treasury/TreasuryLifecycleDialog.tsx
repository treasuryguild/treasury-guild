"use client";

// Archive or restore one treasury. There is no delete: a wallet that has
// built a transaction keeps its row, so payout history and anchor links stay.
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useAsyncData } from "@/hooks/useAsyncData";
import { apiFetch } from "@/lib/api/client";
import type { OkResponse, TreasuryLifecycleStatus } from "@/lib/api/types";
import type { TreasurySummary } from "@/lib/db/types";
import { LifecycleDialog, type LifecycleAction } from "@/components/ui";

export function TreasuryLifecycleDialog({ treasury, onClose, onChanged }: {
  treasury: TreasurySummary;
  onClose: () => void;
  onChanged: (action: "archive" | "restore") => void;
}) {
  const operation = useAsyncAction("Could not update this treasury. Please try again.");
  const status = useAsyncData(treasury.id, () => apiFetch<TreasuryLifecycleStatus>("/api/treasury/lifecycle", {
    query: { treasuryId: treasury.id },
  }));
  const archived = !!status.data?.archivedAt || !!treasury.archived_at;
  const blockers = status.data?.blockers ?? [];

  async function submit(action: LifecycleAction) {
    if (action === "delete" || operation.busy) return;
    const result = await operation.run(() => apiFetch<OkResponse>("/api/treasury/lifecycle", {
      body: { treasuryId: treasury.id, action },
    }));
    if (result) onChanged(action);
    else status.reload();
  }

  return <LifecycleDialog
    title={`Manage ${treasury.name}`}
    noun="treasury"
    status={{ ...status, ready: !!status.data }}
    archived={archived}
    description={archived
      ? "This treasury is archived. Its transactions and on-chain anchors stay with it. Restore it to pay, mint or anchor from it again. A transfer of what it still holds is allowed either way."
      : "Archiving hides this treasury from Payday, payments, minting and anchor builds. Its history stays, and an admin can restore it. The same script cannot be created again; restoring this row is how that wallet comes back."}
    archiveBlocked={blockers.length > 0 ? blockers.join(" ") : null}
    deletion={{
      shown: false,
      allowed: false,
      explanation: null,
      unavailable: null,
      startLabel: "",
      confirmText: "",
      confirmPrompt: null,
    }}
    busy={operation.busy}
    error={operation.error}
    onAction={(action) => void submit(action)}
    onClose={onClose}
    closeLabel="Close"
  />;
}
