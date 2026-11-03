"use client";

import { useId } from "react";
import { useTreasuries } from "@/hooks/useTreasuries";
import type { WorkgroupSummary } from "@/hooks/useWorkgroups";
import { Button, ErrorText, Modal } from "@/components/ui";
import { WalletRouting } from "./WalletRouting";

/** Focused payment-wallet editor opened from the Budgets worksheet. */
export function ChangePaymentWalletDialog({ workgroup, communityId, onChanged, onClose }: {
  workgroup: WorkgroupSummary;
  communityId: string;
  onChanged: (treasuryId: string | null, effective: "current" | "next") => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const treasuries = useTreasuries(communityId);
  const treasuryList = treasuries.data ?? [];

  return (
    <Modal open onClose={onClose} labelledBy={titleId} scroll>
      <h2 id={titleId} className="mb-2 text-lg font-medium">Change payment wallet</h2>
      <p className="mb-5 text-sm text-zinc-400">
        Choose which treasury pays <span className="text-zinc-300">{workgroup.name}</span>.
        A change starts at a budget period boundary.
      </p>
      <div role="status" aria-live="polite"><ErrorText error={treasuries.error} /></div>
      <WalletRouting workgroup={workgroup} treasuries={treasuryList}
        disabled={treasuries.loading || !!treasuries.error}
        className="space-y-3"
        onChanged={(treasuryId, effective) => {
          onChanged(treasuryId, effective);
          onClose();
        }} />
      <div className="mt-5 flex justify-end border-t border-zinc-700 pt-4">
        <Button type="button" variant="secondary" onClick={onClose}>Close</Button>
      </div>
    </Modal>
  );
}
