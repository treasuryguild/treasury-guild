"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type {
  CommunityInviteInfo,
  CreateInviteResponse,
  ListInvitesResponse,
} from "@/lib/api/types";
import {
  DEFAULT_INVITE_EXPIRY_DAYS,
  INVITE_EXPIRY_DAYS,
  INVITE_MAX_USES_PRESETS,
  type InviteExpiryDays,
} from "@/lib/invites/options";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useAsyncData } from "@/hooks/useAsyncData";
import { Button, ErrorText, Input, Select } from "@/components/ui";

function formatWhen(iso: string | null): string {
  if (!iso) return "Never";
  return new Date(iso).toLocaleString(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  });
}

function inviteStatus(invite: CommunityInviteInfo, now = Date.now()): string {
  if (invite.revokedAt) return "Revoked";
  if (invite.expiresAt && Date.parse(invite.expiresAt) <= now) return "Expired";
  if (invite.maxUses !== null && invite.useCount >= invite.maxUses) return "Used up";
  return "Active";
}

export function InviteLinks({ communityId }: { communityId: string }) {
  const list = useAsyncData(communityId, () =>
    apiFetch<ListInvitesResponse>("/api/community/invites", {
      query: { communityId },
    }),
  );
  const action = useAsyncAction();
  const [expiresInDays, setExpiresInDays] = useState<InviteExpiryDays | "never">(
    DEFAULT_INVITE_EXPIRY_DAYS,
  );
  const [maxUses, setMaxUses] = useState<string>("");
  const [label, setLabel] = useState("");
  const [createdUrl, setCreatedUrl] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  async function create() {
    setCreatedUrl(null);
    setCopied(false);
    const result = await action.run(() =>
      apiFetch<CreateInviteResponse>("/api/community/invites", {
        body: {
          communityId,
          expiresInDays: expiresInDays === "never" ? null : expiresInDays,
          maxUses: maxUses === "" ? null : Number(maxUses),
          label: label.trim() || null,
        },
      }),
    );
    if (result) {
      setCreatedUrl(result.url);
      setLabel("");
      list.reload();
    }
  }

  async function revoke(inviteId: string) {
    const ok = await action.run(() =>
      apiFetch("/api/community/invites", {
        method: "DELETE",
        body: { communityId, inviteId },
      }),
    );
    if (ok) {
      if (createdUrl) setCreatedUrl(null);
      list.reload();
    }
  }

  async function copyUrl(url: string) {
    try {
      await navigator.clipboard.writeText(url);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }

  const invites = list.data?.invites ?? [];

  return (
    <div className="mt-4 border-t border-zinc-800 pt-4">
      <h4 className="text-sm font-medium">Invite links</h4>
      <p className="mt-1 text-xs text-zinc-500">
        Share a link so people can join with their wallet. They set a handle and
        link Discord, GitHub or Google on their own profile afterwards. The full
        URL is shown once when you create it — copy it before leaving this page.
      </p>

      <div className="mt-3 flex flex-col gap-2 sm:flex-row sm:flex-wrap sm:items-end">
        <label className="text-xs text-zinc-400">
          Expires
          <Select
            className="mt-1 block"
            value={String(expiresInDays)}
            disabled={action.busy}
            onChange={(e) => {
              const v = e.target.value;
              setExpiresInDays(v === "never" ? "never" : Number(v) as InviteExpiryDays);
            }}
          >
            {INVITE_EXPIRY_DAYS.map((d) => (
              <option key={d} value={d}>
                In {d} days
              </option>
            ))}
            <option value="never">Never</option>
          </Select>
        </label>
        <label className="text-xs text-zinc-400">
          Max uses
          <Select
            className="mt-1 block"
            value={maxUses}
            disabled={action.busy}
            onChange={(e) => setMaxUses(e.target.value)}
          >
            <option value="">Unlimited</option>
            {INVITE_MAX_USES_PRESETS.map((n) => (
              <option key={n} value={n}>
                {n}
              </option>
            ))}
          </Select>
        </label>
        <label className="text-xs text-zinc-400 sm:min-w-[12rem] sm:flex-1">
          Label (optional)
          <Input
            className="mt-1"
            value={label}
            maxLength={100}
            disabled={action.busy}
            placeholder="e.g. Discord onboarding"
            onChange={(e) => setLabel(e.target.value)}
          />
        </label>
        <Button disabled={action.busy} onClick={() => void create()}>
          Create invite link
        </Button>
      </div>

      {createdUrl && (
        <div className="mt-3 rounded-md border border-zinc-700 bg-zinc-900/60 p-3">
          <p className="text-xs text-zinc-400">New invite — copy now:</p>
          <p className="mt-1 break-all font-mono text-xs">{createdUrl}</p>
          <Button
            className="mt-2"
            variant="secondary"
            onClick={() => void copyUrl(createdUrl)}
          >
            {copied ? "Copied" : "Copy link"}
          </Button>
        </div>
      )}

      {invites.length > 0 && (
        <ul className="mt-4 space-y-2">
          {invites.map((invite) => {
            const status = inviteStatus(invite);
            const active = status === "Active";
            return (
              <li
                key={invite.id}
                className="flex flex-wrap items-center justify-between gap-2 rounded-md border border-zinc-800 px-3 py-2 text-xs"
              >
                <div>
                  <p className="text-zinc-300">
                    {invite.label ?? "Invite"} · {status}
                    {invite.maxUses !== null && (
                      <span className="text-zinc-500">
                        {" "}
                        · {invite.useCount}/{invite.maxUses} uses
                      </span>
                    )}
                    {invite.maxUses === null && invite.useCount > 0 && (
                      <span className="text-zinc-500">
                        {" "}
                        · {invite.useCount} joined
                      </span>
                    )}
                  </p>
                  <p className="mt-0.5 text-zinc-500">
                    Created {formatWhen(invite.createdAt)}
                    {invite.expiresAt && ` · Expires ${formatWhen(invite.expiresAt)}`}
                  </p>
                </div>
                {active && (
                  <Button
                    variant="secondary"
                    disabled={action.busy}
                    onClick={() => void revoke(invite.id)}
                  >
                    Revoke
                  </Button>
                )}
              </li>
            );
          })}
        </ul>
      )}

      <ErrorText error={action.error ?? list.error} className="mt-3" />
    </div>
  );
}
