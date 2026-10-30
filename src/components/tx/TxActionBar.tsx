"use client";

import { useState } from "react";
import type { TxAction } from "@/hooks/useTxActions";
import { Button, ConfirmDialog, WarningText } from "@/components/ui";

export function TxActionBar({
  canRespond,
  thresholdMet,
  busy,
  refreshing,
  isPayout,
  hasSignatures = false,
  blockedReason = null,
  onSign,
  onReject,
  onSubmit,
  onDelete,
}: {
  /** The signer has neither signed nor rejected yet. */
  canRespond: boolean;
  thresholdMet: boolean;
  busy: TxAction | null;
  /** The page is re-rendering after an action; keep everything disabled. */
  refreshing: boolean;
  isPayout: boolean;
  /** Once any signature exists, delete is refused; reject instead. */
  hasSignatures?: boolean;
  /**
   * Why signing/submitting is unavailable right now (e.g. the wallet is on
   * the other network). Reject and delete never need the wallet's network.
   */
  blockedReason?: string | null;
  onSign: () => void;
  onReject: () => void;
  onSubmit: () => void;
  onDelete: () => Promise<void>;
}) {
  const [confirmDelete, setConfirmDelete] = useState(false);
  const disabled = busy !== null || refreshing;
  const chainDisabled = disabled || !!blockedReason;

  return (
    <div className="flex flex-wrap gap-3">
      <WarningText small className="w-full">{blockedReason}</WarningText>
      {canRespond && (
        <>
          <Button onClick={onSign} disabled={chainDisabled} loading={busy === "sign"}>
            {busy === "sign" ? "Check your wallet…" : "Sign"}
          </Button>
          <Button
            variant="danger"
            onClick={onReject}
            disabled={disabled}
            loading={busy === "reject"}
          >
            {busy === "reject" ? "Rejecting…" : "Reject"}
          </Button>
        </>
      )}
      {thresholdMet && (
        <Button onClick={onSubmit} disabled={chainDisabled} loading={busy === "submit"}>
          {busy === "submit" ? "Submitting to chain…" : "Submit to chain"}
        </Button>
      )}
      {!hasSignatures && (
        <span className="ml-auto">
          <Button
            variant="secondary"
            onClick={() => setConfirmDelete(true)}
            disabled={disabled}
          >
            Delete
          </Button>
        </span>
      )}
      <ConfirmDialog
        open={confirmDelete}
        title="Delete this transaction?"
        confirmLabel="Delete"
        busy={busy === "delete" || (confirmDelete && refreshing)}
        onCancel={() => setConfirmDelete(false)}
        onConfirm={() => {
          void onDelete().finally(() => setConfirmDelete(false));
        }}
      >
        The unsigned transaction is discarded
        {isPayout ? " and its queued tasks become payable again" : ""}. Signers
        can build a new one afterwards.
      </ConfirmDialog>
    </div>
  );
}
