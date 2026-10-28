"use client";

// Collapsible Integrations hub section. Opens when incomplete, when the URL
// hash matches, or when the user expands it; hash navigation re-opens the match.
import { useEffect, useRef, useState, type ReactNode } from "react";

export function IntegrationSection({
  id,
  title,
  status,
  incomplete = false,
  children,
}: {
  id: string;
  title: string;
  /** Short status shown in the collapsed summary. */
  status: ReactNode;
  /** When true, the section starts open (and stays preferred-open). */
  incomplete?: boolean;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(incomplete);
  const detailsRef = useRef<HTMLDetailsElement>(null);

  useEffect(() => {
    function syncFromHash() {
      const hash = window.location.hash.replace(/^#/, "");
      if (hash === id) {
        setOpen(true);
        // Defer scroll until the details body is open.
        requestAnimationFrame(() => {
          detailsRef.current?.scrollIntoView({ block: "start" });
        });
      }
    }
    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    return () => window.removeEventListener("hashchange", syncFromHash);
  }, [id]);

  useEffect(() => {
    if (incomplete) setOpen(true);
  }, [incomplete]);

  return (
    <details
      ref={detailsRef}
      id={id}
      open={open}
      onToggle={(e) => setOpen((e.target as HTMLDetailsElement).open)}
      className="glass-panel group scroll-mt-4 rounded-2xl"
    >
      <summary className="cursor-pointer list-none px-5 py-4 [&::-webkit-details-marker]:hidden">
        <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
          <span className="font-medium">
            <span className="mr-2 inline-block text-zinc-500 transition-transform group-open:rotate-90">
              ▸
            </span>
            {title}
          </span>
          <span className="text-sm text-zinc-400">{status}</span>
        </div>
      </summary>
      <div className="space-y-3 border-t border-zinc-800 px-5 py-4">{children}</div>
    </details>
  );
}
