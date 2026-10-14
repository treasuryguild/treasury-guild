import type { ReactNode } from "react";
import { CallState, TaskSource, TxKind, txStateMeta, type StateTone } from "@/lib/constants";

export type BadgeTone = "default" | StateTone;

const TONE_CLASS: Record<BadgeTone, string> = {
  default: "badge-default",
  green: "badge-green",
  yellow: "badge-yellow",
  red: "badge-red",
  blue: "badge-blue",
};

export function Badge({
  children,
  tone = "default",
  className = "",
}: {
  children: ReactNode;
  tone?: BadgeTone;
  className?: string;
}) {
  return (
    <span
      className={`inline-flex shrink-0 items-center whitespace-nowrap rounded-full border px-2.5 py-0.5 text-xs font-medium ${TONE_CLASS[tone]} ${className}`}
    >
      {children}
    </span>
  );
}

/** transactions.state as a labelled badge. */
export function TxStateBadge({ state }: { state: number }) {
  const meta = txStateMeta(state);
  return <Badge tone={meta.tone}>{meta.label}</Badge>;
}

/** "Mint" / "Payment" / "Anchor" marker for those transaction kinds; renders nothing for payouts. */
export function TxKindBadge({ kind }: { kind: string }) {
  if (kind === TxKind.Mint) return <Badge tone="blue">Mint</Badge>;
  if (kind === TxKind.Payment) return <Badge tone="blue">Payment</Badge>;
  if (kind === TxKind.Anchor) return <Badge tone="blue">Anchor</Badge>;
  return null;
}

/** calls.state as a labelled badge. */
export function CallStateBadge({ state }: { state: string }) {
  const finalized = state === CallState.Finalized;
  return <Badge tone={finalized ? "green" : "default"}>{finalized ? "Finalized" : "Open"}</Badge>;
}

/** "github" / "native" source marker. */
export function SourceBadge({ source }: { source: string }) {
  return (
    <Badge tone={source === TaskSource.Github ? "blue" : "default"}>
      {source}
    </Badge>
  );
}
