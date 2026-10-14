"use client";

import { useEffect, type ReactNode } from "react";
import { Button } from "./Button";
import { ErrorText } from "./PageState";

const SCROLL_CLASS = "max-h-[calc(100dvh-2rem)] overflow-y-auto";

/**
 * Backdrop + panel. Closes on backdrop click and Escape, except while `busy`
 * (an action is running and the dialog holds its result). `scroll` keeps a
 * tall panel inside the viewport.
 */
export function Modal({
  open,
  onClose,
  title,
  children,
  className = "",
  labelledBy,
  busy = false,
  scroll = false,
}: {
  open: boolean;
  onClose: () => void;
  title?: ReactNode;
  children: ReactNode;
  className?: string;
  labelledBy?: string;
  busy?: boolean;
  scroll?: boolean;
}) {
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [open, onClose, busy]);

  if (!open) return null;
  return (
    <div
      className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/60"
      onClick={busy ? undefined : onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby={labelledBy}
        className={`modal-panel glass-panel max-w-lg rounded-2xl p-5 ${scroll ? SCROLL_CLASS : ""} ${className}`}
        onClick={(e) => e.stopPropagation()}
      >
        {title && <h2 className="mb-4 text-lg font-medium">{title}</h2>}
        {children}
      </div>
    </div>
  );
}

/** Yes/no confirmation dialog for destructive actions. */
export function ConfirmDialog({
  open,
  title,
  children,
  confirmLabel = "Confirm",
  cancelLabel = "Cancel",
  busy = false,
  error,
  danger = true,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: ReactNode;
  children?: ReactNode;
  confirmLabel?: string;
  cancelLabel?: string;
  busy?: boolean;
  error?: string | null;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  return (
    <Modal open={open} onClose={onCancel} busy={busy} title={title}>
      {children && <div className="text-sm text-zinc-400">{children}</div>}
      <ErrorText error={error} className="mt-3" />
      <div className="mt-5 flex justify-end gap-2">
        <Button variant="secondary" onClick={onCancel} disabled={busy}>
          {cancelLabel}
        </Button>
        <Button
          variant={danger ? "danger" : "primary"}
          onClick={onConfirm}
          loading={busy}
        >
          {busy ? "Working…" : confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}
