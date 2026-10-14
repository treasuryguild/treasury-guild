import type { ReactNode } from "react";

/** Highlighted aside inside a doc page (available in MDX without imports). */
export function Callout({
  tone = "info",
  title,
  children,
}: {
  tone?: "info" | "warning";
  title?: string;
  children: ReactNode;
}) {
  return (
    <aside className={`docs-callout docs-callout-${tone}`} role="note">
      {title && <p className="docs-callout-title">{title}</p>}
      {children}
    </aside>
  );
}
