"use client";

import { apiFetch } from "@/lib/api/client";
import type { CheckinCodeResponse } from "@/lib/api/types";
import { checkinWindow } from "@/lib/calls/checkinCode";
import { routes } from "@/lib/routes";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useAsyncData } from "@/hooks/useAsyncData";
import { useNow } from "@/hooks/useNow";
import { Badge, Button, Card, CopyButton, ErrorText, SectionTitle } from "@/components/ui";

const WINDOW_BADGE = {
  early: { tone: "yellow", label: "Opens 15 min before the start" },
  open: { tone: "green", label: "Open now" },
  closed: { tone: "default", label: "Closed" },
} as const;

/**
 * The manager's side of check-in: the code and link to share in the call.
 * Attendees open the link (or type the code) signed in with their wallet, so
 * no name matching is needed, on any platform.
 */
export function CheckinPanel({
  slug,
  call,
}: {
  slug: string;
  call: { id: string; starts_at: string; ends_at: string };
}) {
  const path = `/api/calls/${call.id}/checkin-code`;
  const code = useAsyncData(call.id, () => apiFetch<CheckinCodeResponse>(path));
  const action = useAsyncAction();
  // The window is a clock reading: keep it current while the page stays open.
  const now = useNow();

  const window_ = checkinWindow(call, now);
  const badge = WINDOW_BADGE[window_];
  const current = code.data?.code ?? null;
  const link = current && typeof window !== "undefined"
    ? `${window.location.origin}${routes.callCheckin(slug, call.id)}?code=${current}`
    : null;

  async function change(method: "POST" | "DELETE") {
    const result = await action.run(() => apiFetch<CheckinCodeResponse>(path, { method }));
    if (result) code.setData(result);
  }

  return (
    <Card>
      <SectionTitle action={<Badge tone={badge.tone}>{badge.label}</Badge>}>Check-in</SectionTitle>
      <p className="mb-4 text-sm text-zinc-400">
        Share the link or the code in the call. Attendees confirm with their signed-in wallet
        and land on the list already linked.
      </p>
      {current && link ? (
        <div className="space-y-3">
          <div className="flex flex-wrap items-center gap-3">
            <span className="font-mono text-2xl tracking-[0.3em]">{current}</span>
            <CopyButton value={current} label="Copy code" />
          </div>
          <div className="flex min-w-0 items-center gap-2">
            <span className="min-w-0 truncate font-mono text-xs text-zinc-400">{link}</span>
            <CopyButton value={link} label="Copy check-in link" />
          </div>
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" loading={action.busy} onClick={() => void change("POST")}>New code</Button>
            <Button variant="ghost" disabled={action.busy} onClick={() => void change("DELETE")}>Close check-in</Button>
          </div>
        </div>
      ) : (
        <Button loading={action.busy || code.loading} disabled={window_ === "closed"} onClick={() => void change("POST")}>
          Create check-in code
        </Button>
      )}
      <ErrorText error={action.error ?? code.error} className="mt-3" />
    </Card>
  );
}
