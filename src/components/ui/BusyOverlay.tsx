"use client";

// Full-page "working…" overlay for steps the user must wait through (building
// a transaction, signing, submitting). Not dismissable: it exists so nobody
// clicks away mid-operation.
import { useEffect } from "react";
import { Spinner } from "./Spinner";

export function BusyOverlay({
  open,
  title,
  hint = "Keep this tab open.",
}: {
  open: boolean;
  title: string;
  hint?: string | null;
}) {
  useEffect(() => {
    if (!open) return;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [open]);

  if (!open) return null;
  return (
    <div
      role="status"
      aria-live="polite"
      aria-busy="true"
      className="modal-backdrop fixed inset-0 z-50 flex items-center justify-center bg-black/60"
    >
      <div className="modal-panel glass-panel flex max-w-sm flex-col items-center gap-3 rounded-2xl p-6 text-center">
        <Spinner className="h-8 w-8 text-[var(--accent)]" />
        <p className="text-base font-medium">{title}</p>
        {hint && <p className="text-sm text-zinc-400">{hint}</p>}
      </div>
    </div>
  );
}
