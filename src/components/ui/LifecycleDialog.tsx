"use client";

import { useId, useState, type ReactNode } from "react";
import { Button } from "./Button";
import { Input } from "./Form";
import { Modal } from "./Modal";
import { ErrorText, WarningText } from "./PageState";

export type LifecycleAction = "archive" | "restore" | "delete";

/**
 * Archive / restore / permanently delete one item (a task, a workgroup): the
 * item's status is checked first, archiving can be blocked with a reason, and
 * deletion is typed out. Loading and writing stay with the caller.
 */
export function LifecycleDialog({
  title, noun, status, archived, description, children, archiveBlocked,
  deletion, busy, error, onAction, onClose, closeLabel = "Cancel",
}: {
  title: ReactNode;
  /** "task", "workgroup": the status and progress lines name it. */
  noun: string;
  status: { loading: boolean; error: string | null; ready: boolean; reload: () => void };
  archived: boolean;
  description: ReactNode;
  /** Extra detail under the description (a task's body). */
  children?: ReactNode;
  /** Why the item cannot be archived yet; null when it can. */
  archiveBlocked: ReactNode | null;
  deletion: {
    /** Offer the section at all (a task only once archived). */
    shown: boolean;
    allowed: boolean;
    /** What deleting removes (when allowed) or why it is unavailable. */
    explanation: ReactNode;
    unavailable: ReactNode;
    startLabel: string;
    /** The text to type, and its prompt. */
    confirmText: string;
    confirmPrompt: ReactNode;
  };
  busy: boolean;
  error: string | null;
  /** The typed confirmation goes with a delete. */
  onAction: (action: LifecycleAction, confirmation: string) => void;
  onClose: () => void;
  closeLabel?: string;
}) {
  const titleId = useId();
  const [deleting, setDeleting] = useState(false);
  const [confirmation, setConfirmation] = useState("");
  const unavailable = status.loading || !!status.error;

  return <Modal open onClose={onClose} busy={busy} labelledBy={titleId} scroll>
    <h2 id={titleId} className="mb-3 break-words text-lg font-medium">{title}</h2>
    {status.loading && <p role="status" className="text-sm text-zinc-400">Checking {noun} activity…</p>}
    <ErrorText error={status.error} />
    {status.error && <Button variant="secondary" onClick={status.reload}>Retry</Button>}
    {status.ready && <div className="space-y-4">
      <p className="text-sm text-zinc-400">{description}</p>
      {children}
      {!archived && <WarningText>{archiveBlocked}</WarningText>}
      <Button disabled={busy || unavailable || (!archived && !!archiveBlocked)}
        onClick={() => onAction(archived ? "restore" : "archive", confirmation)}>
        {archived ? `Restore ${noun}` : `Archive ${noun}`}
      </Button>
      {deletion.shown && <div className="border-t border-zinc-700 pt-4">
        {deletion.allowed ? <>
          <p className="mb-3 text-sm text-zinc-400">{deletion.explanation}</p>
          {deleting ? <>
            <label className="mb-2 block text-sm" htmlFor={`${titleId}-confirm`}>{deletion.confirmPrompt}</label>
            <Input id={`${titleId}-confirm`} value={confirmation} disabled={busy} onChange={(e) => setConfirmation(e.target.value)} />
            <Button variant="danger" className="mt-3" loading={busy}
              disabled={unavailable || confirmation !== deletion.confirmText}
              onClick={() => onAction("delete", confirmation)}>Delete permanently</Button>
          </> : <Button variant="danger" disabled={busy || unavailable}
            onClick={() => setDeleting(true)}>{deletion.startLabel}</Button>}
        </> : <p className="text-sm text-zinc-500">{deletion.unavailable}</p>}
      </div>}
    </div>}
    {busy && <p role="status" className="mt-4 text-sm text-zinc-400">Updating {noun}…</p>}
    <div role="alert" className="mt-4"><ErrorText error={error} /></div>
    <div className="mt-5 flex justify-end"><Button variant="secondary" disabled={busy} onClick={onClose}>{closeLabel}</Button></div>
  </Modal>;
}
