"use client";

// Admin-only row: connect, replace or remove a Discord webhook (a treasury's
// payout notifications, the community's proposal announcements). The URL is
// only ever typed here; the API returns a masked hint afterwards.
import { useState, type ReactNode } from "react";
import { apiFetch } from "@/lib/api/client";
import type { DiscordWebhookStatus } from "@/lib/api/types";
import { formatDate } from "@/lib/format";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { Button, ConfirmDialog, ErrorText, Input, NoticeText } from "@/components/ui";

export function DiscordWebhookControl({
  endpoint,
  target,
  status,
  onChanged,
  removeText,
}: {
  /** The route that saves (POST) and removes (DELETE) the webhook. */
  endpoint: string;
  /** What the webhook belongs to, sent with every request ({ treasuryId } or { communityId }). */
  target: Record<string, string>;
  /** Null while not connected (or still loading). */
  status: DiscordWebhookStatus | null;
  onChanged: () => void;
  /** What removing it stops, for the confirmation. */
  removeText: ReactNode;
}) {
  const action = useAsyncAction();
  const [editing, setEditing] = useState(false);
  const [url, setUrl] = useState("");
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  async function save() {
    const saved = await action.run(() =>
      apiFetch<{ webhook: DiscordWebhookStatus | null }>(endpoint, {
        body: { ...target, url },
      }),
    );
    if (!saved) return;
    setEditing(false);
    setUrl("");
    setNotice("Connected — a test message was posted to the channel.");
    onChanged();
  }

  async function remove() {
    const ok = await action.run(() =>
      apiFetch(endpoint, { method: "DELETE", body: target }),
    );
    setConfirmRemove(false);
    if (!ok) return;
    setNotice(null);
    onChanged();
  }

  function cancelEdit() {
    setEditing(false);
    setUrl("");
    action.setError(null);
  }

  return (
    <div className="mt-4 border-t border-zinc-800 pt-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-zinc-400">Discord</span>
        {status ? (
          <>
            <span className="font-mono text-xs text-zinc-500" title="Webhook URL (masked)">
              {status.urlHint}
            </span>
            {status.lastPostedAt && (
              <span className="text-xs text-zinc-500">
                last posted {formatDate(status.lastPostedAt, "datetime")}
              </span>
            )}
          </>
        ) : (
          <span className="text-zinc-500">not connected</span>
        )}
        {!editing && (
          <span className="ml-auto flex gap-2">
            <Button variant="secondary" onClick={() => setEditing(true)} disabled={action.busy}>
              {status ? "Replace" : "Connect"}
            </Button>
            {status && (
              <Button variant="secondary" onClick={() => setConfirmRemove(true)} disabled={action.busy}>
                Remove
              </Button>
            )}
          </span>
        )}
      </div>

      {editing && (
        <form
          className="mt-2 flex flex-wrap gap-2"
          onSubmit={(e) => {
            e.preventDefault();
            void save();
          }}
        >
          <Input
            type="url"
            className="min-w-0 flex-1"
            placeholder="https://discord.com/api/webhooks/…"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            autoFocus
            required
          />
          <Button type="submit" loading={action.busy} disabled={url.trim() === ""}>
            {action.busy ? "Testing…" : "Save"}
          </Button>
          <Button type="button" variant="secondary" onClick={cancelEdit} disabled={action.busy}>
            Cancel
          </Button>
        </form>
      )}

      <ErrorText error={action.error ?? status?.lastError ?? null} className="mt-2" />
      <NoticeText className="mt-2">{notice}</NoticeText>

      <ConfirmDialog
        open={confirmRemove}
        title="Disconnect Discord?"
        confirmLabel="Remove"
        busy={action.busy}
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() => void remove()}
      >
        {removeText} You can connect a webhook again at any time.
      </ConfirmDialog>
    </div>
  );
}
