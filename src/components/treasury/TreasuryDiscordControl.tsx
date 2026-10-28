"use client";

// Admin-only row: connect, replace or remove a treasury's payout Discord
// destination — a bot channel on the community's connected server, or a
// pasted incoming-webhook URL when the bot is not used.
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { apiFetch } from "@/lib/api/client";
import type {
  TreasuryDiscordDestinationStatus,
  TreasuryDiscordDestinationsResponse,
} from "@/lib/api/types";
import { formatDate } from "@/lib/format";
import { routes } from "@/lib/routes";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { Button, ConfirmDialog, ErrorText, Field, Input, NoticeText, Select } from "@/components/ui";

function channelLabel(c: { name: string; type: number }): string {
  const kind = c.type === 5 ? "announcement" : "text";
  return `#${c.name} (${kind})`;
}

export function TreasuryDiscordControl({
  communityId,
  treasuryId,
  slug,
  serverConnected,
  status,
  onChanged,
  removeText,
}: {
  communityId: string;
  treasuryId: string;
  slug: string;
  serverConnected: boolean;
  status: TreasuryDiscordDestinationStatus | null;
  onChanged: () => void;
  removeText: ReactNode;
}) {
  const action = useAsyncAction();
  const [editing, setEditing] = useState(false);
  const [mode, setMode] = useState<"channel" | "webhook">("channel");
  const [channelId, setChannelId] = useState("");
  const [url, setUrl] = useState("");
  const [channels, setChannels] = useState<{ id: string; name: string; type: number }[] | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!editing) return;
    const preferChannel = serverConnected && status?.mode !== "webhook";
    setMode(preferChannel ? "channel" : "webhook");
    setChannelId(status?.mode === "channel" ? (status.channelId ?? "") : "");
    setUrl("");
    setChannels(null);
    // Only reset when opening the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional
  }, [editing]);

  useEffect(() => {
    if (!editing || mode !== "channel" || !serverConnected) return;
    let cancelled = false;
    void (async () => {
      const res = await action.run(() =>
        apiFetch<TreasuryDiscordDestinationsResponse>("/api/treasury/discord", {
          query: { communityId, channels: "1" },
        }),
      );
      if (cancelled || !res) return;
      setChannels(res.channels ?? []);
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional
  }, [editing, mode, communityId, serverConnected]);

  async function save() {
    const body = mode === "channel"
      ? { treasuryId, channelId }
      : { treasuryId, url };
    const saved = await action.run(() =>
      apiFetch<{ destination: TreasuryDiscordDestinationStatus }>("/api/treasury/discord", {
        body,
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
      apiFetch("/api/treasury/discord", { method: "DELETE", body: { treasuryId } }),
    );
    setConfirmRemove(false);
    if (!ok) return;
    setNotice(null);
    onChanged();
  }

  function cancelEdit() {
    setEditing(false);
    setUrl("");
    setChannelId("");
    setChannels(null);
    action.setError(null);
  }

  const canSave = mode === "channel" ? channelId !== "" : url.trim() !== "";

  return (
    <div className="mt-4 border-t border-zinc-800 pt-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-zinc-400">Discord</span>
        {status ? (
          <>
            {status.mode === "webhook" ? (
              <span className="font-mono text-xs text-zinc-500" title="Webhook URL (masked)">
                {status.urlHint}
              </span>
            ) : (
              <span className="text-zinc-300">
                channel connected
                {status.channelType === 5 ? " (announcement)" : ""}
              </span>
            )}
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
        <div className="mt-3 space-y-2">
          {serverConnected ? (
            <div className="flex flex-wrap gap-2 text-xs">
              <Button
                type="button"
                variant={mode === "channel" ? "primary" : "secondary"}
                onClick={() => setMode("channel")}
                disabled={action.busy}
              >
                Choose channel
              </Button>
              <Button
                type="button"
                variant={mode === "webhook" ? "primary" : "secondary"}
                onClick={() => setMode("webhook")}
                disabled={action.busy}
              >
                Use a webhook URL
              </Button>
            </div>
          ) : (
            <p className="text-xs text-zinc-500">
              Paste a webhook URL, or{" "}
              <Link className="underline" href={`${routes.integrations(slug)}#discord`}>
                connect a Discord server
              </Link>
              {" "}to pick a channel instead.
            </p>
          )}

          {mode === "channel" && serverConnected ? (
            <Field
              label="Channel"
              size="sm"
              hint="Text or announcement channels only. Re-add the bot under Integrations if channels are missing after a permission update."
            >
              <Select
                aria-label="Discord channel"
                value={channelId}
                onChange={(e) => setChannelId(e.target.value)}
              >
                <option value="">Select a channel…</option>
                {(channels ?? []).map((c) => (
                  <option key={c.id} value={c.id}>{channelLabel(c)}</option>
                ))}
              </Select>
            </Field>
          ) : (
            <form
              className="flex flex-wrap gap-2"
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
            </form>
          )}

          <div className="flex flex-wrap gap-2">
            <Button onClick={() => void save()} loading={action.busy} disabled={!canSave}>
              {action.busy ? "Testing…" : "Save"}
            </Button>
            <Button type="button" variant="secondary" onClick={cancelEdit} disabled={action.busy}>
              Cancel
            </Button>
          </div>
        </div>
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
        {removeText} You can connect again at any time.
      </ConfirmDialog>
    </div>
  );
}
