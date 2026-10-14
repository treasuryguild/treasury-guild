import type { ReactNode } from "react";

export function Card({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`glass-panel rounded-2xl p-5 ${className}`}>{children}</div>
  );
}

/** A subdued row inside a Card (list items, key/value pairs). */
export function InsetRow({
  children,
  className = "",
  stack = true,
}: {
  children: ReactNode;
  className?: string;
  /** Stack on small screens, row on sm+ (default). */
  stack?: boolean;
}) {
  const layout = stack
    ? "flex flex-col items-start justify-between gap-2 sm:flex-row sm:items-center"
    : "flex items-center justify-between gap-2";
  return (
    <div className={`${layout} rounded-xl bg-zinc-800/60 px-3 py-2 ${className}`}>
      {children}
    </div>
  );
}

/** A bordered sub-panel (nested forms, repeaters). */
export function Panel({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-lg border border-zinc-800 p-4 ${className}`}>
      {children}
    </div>
  );
}
