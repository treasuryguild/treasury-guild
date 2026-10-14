import type { ReactNode } from "react";
import { Card } from "./Card";

/** A quiet full-page message (access gates, not-found). */
export function PageMessage({ children }: { children: ReactNode }) {
  return <p className="text-zinc-400">{children}</p>;
}

/** Inline error line; renders nothing when there is no error. */
export function ErrorText({
  error,
  className = "",
}: {
  error: string | null | undefined;
  className?: string;
}) {
  if (!error) return null;
  return <p className={`text-sm text-red-400 ${className}`}>{error}</p>;
}

/** Inline success/notice line; renders nothing when empty. */
export function NoticeText({
  children,
  className = "",
}: {
  children: ReactNode;
  className?: string;
}) {
  if (!children) return null;
  return <p role="status" className={`text-sm text-emerald-400 ${className}`}>{children}</p>;
}

/** Inline warning (why an action is blocked, a limit close by); renders nothing when empty. */
export function WarningText({
  children,
  small = false,
  className = "",
}: {
  children: ReactNode;
  small?: boolean;
  className?: string;
}) {
  if (!children) return null;
  return (
    <p role="status" className={`${small ? "text-xs" : "text-sm"} text-amber-500 ${className}`}>
      {children}
    </p>
  );
}

/** Empty-list placeholder. `card` wraps it in a Card. */
export function EmptyState({
  children,
  action,
  card = true,
}: {
  children: ReactNode;
  action?: ReactNode;
  card?: boolean;
}) {
  const body = (
    <div className="space-y-3">
      <p className="text-sm text-zinc-500">{children}</p>
      {action}
    </div>
  );
  return card ? <Card>{body}</Card> : body;
}
