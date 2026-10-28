"use client";

// Admin control on the Integrations hub: pick a Discord text or forum channel
// for proposal announcements and auto discussion threads. The Discord server
// is the section above; this only chooses the channel.
import Link from "next/link";
import { useEffect, useState, type ReactNode } from "react";
import { apiFetch } from "@/lib/api/client";
import type { GovernanceDiscordResponse, GovernanceDiscordStatus } from "@/lib/api/types";
import { formatDate } from "@/lib/format";
import { routes } from "@/lib/routes";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { Button, ConfirmDialog, ErrorText, NoticeText } from "@/components/ui";

function channelLabel(c: { name: string; type: number }): string {
  const kind = c.type === 15 ? "forum" : c.type === 5 ? "announcement" : "text";
  return `#${c.name} (${kind})`;
}

export function GovernanceDiscordControl({
  communityId,
  slug,
  status,
  onChanged,
  removeText,
}: {
  communityId: string;
  slug: string;
  status: GovernanceDiscordStatus | null;
  onChanged: () => void;
  removeText: ReactNode;
}) {
  const action = useAsyncAction();
  const [editing, setEditing] = useState(false);
  const [channelId, setChannelId] = useState("");
  const [channels, setChannels] = useState<{ id: string; name: string; type: number }[] | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  useEffect(() => {
    if (!editing || !status?.serverConnected) return;
    let cancelled = false;
    void (async () => {
      const res = await action.run(() =>
        apiFetch<GovernanceDiscordResponse>("/api/governance/discord", {
          query: { communityId, channels: "1" },
        }),
      );
      if (cancelled || !res) return;
      setChannels(res.channels ?? []);
      if (res.discord.channelId) setChannelId(res.discord.channelId);
    })();
    return () => { cancelled = true; };
    // Only refetch when opening the editor.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- intentional
  }, [editing, communityId, status?.serverConnected]);

  async function save() {
    const saved = await action.run(() =>
      apiFetch<GovernanceDiscordResponse>("/api/governance/discord", {
        body: { communityId, channelId },
      }),
    );
    if (!saved) return;
    setEditing(false);
    setNotice("Connected — a test message was posted to the channel.");
    onChanged();
  }

  async function remove() {
    const ok = await action.run(() =>
      apiFetch("/api/governance/discord", { method: "DELETE", body: { communityId } }),
    );
    setConfirmRemove(false);
    if (!ok) return;
    setNotice(null);
    onChanged();
  }

  function cancelEdit() {
    setEditing(false);
    setChannelId("");
    setChannels(null);
    action.setError(null);
  }

  if (!status) return null;

  return (
    <div className="mt-4 border-t border-zinc-800 pt-3 text-sm">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span className="text-zinc-400">Discord</span>
        {!status.serverConnected ? (
          <span className="text-zinc-500">
            Connect a Discord server in the{" "}
            <Link className="underline" href={`${routes.integrations(slug)}#discord`}>Discord server</Link>
            {" "}section first, then pick a channel here.
          </span>
        ) : status.channelId ? (
          <>
            <span className="text-zinc-300">
              {status.serverLabel ? `${status.serverLabel} · ` : ""}
              channel connected
              {status.channelType === 15 ? " (forum)" : ""}
            </span>
            {status.lastPostedAt && (
              <span className="text-xs text-zinc-500">
                last posted {formatDate(status.lastPostedAt, "datetime")}
              </span>
            )}
          </>
        ) : (
          <span className="text-zinc-500">
            Server {status.serverLabel ?? "connected"} — choose a channel to announce proposals.
          </span>
        )}
      </div>
      {status.lastError && (
        <p className="mt-2 text-xs text-amber-400">Last Discord error: {status.lastError}</p>
      )}
      <NoticeText className="mt-2">{notice}</NoticeText>
      <ErrorText error={action.error} className="mt-2" />

      {editing && status.serverConnected ? (
        <div className="mt-3 space-y-2">
          <label className="block text-xs text-zinc-500">
            Channel
            <select
              className="mt-1 w-full rounded-lg border border-zinc-700 bg-zinc-900 px-3 py-2 text-sm"
              value={channelId}
              onChange={(e) => setChannelId(e.target.value)}
              aria-label="Discord channel"
            >
              <option value="">Select a channel…</option>
              {(channels ?? []).map((c) => (
                <option key={c.id} value={c.id}>{channelLabel(c)}</option>
              ))}
            </select>
          </label>
          <p className="text-xs text-zinc-500">A forum channel is best: one post per proposal. Re-add the bot under Integrations if channels are missing after a permission update.</p>
          <div className="flex flex-wrap gap-2">
            <Button onClick={save} disabled={!channelId || action.busy}>
              {action.busy ? "Saving…" : "Save channel"}
            </Button>
            <Button variant="secondary" onClick={cancelEdit} disabled={action.busy}>Cancel</Button>
          </div>
        </div>
      ) : (
        <div className="mt-3 flex flex-wrap gap-2">
          {status.serverConnected && (
            <Button variant="secondary" onClick={() => setEditing(true)}>
              {status.channelId ? "Change channel" : "Choose channel"}
            </Button>
          )}
          {status.channelId && (
            <Button variant="secondary" onClick={() => setConfirmRemove(true)}>Disconnect channel</Button>
          )}
        </div>
      )}

      <ConfirmDialog
        open={confirmRemove}
        title="Disconnect Discord channel?"
        confirmLabel="Disconnect"
        busy={action.busy}
        onCancel={() => setConfirmRemove(false)}
        onConfirm={() => void remove()}
      >
        {removeText}
      </ConfirmDialog>
    </div>
  );
}
