"use client";

// Endorse / peer-kudos controls on a paid task (shown inside TaskModal).
import { useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { RecognitionCreatedResponse } from "@/lib/api/types";
import { Button, ErrorText, Field, Input } from "@/components/ui";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useRecognitionTaskEvents } from "@/hooks/useRecognition";
import { RecognitionKind, PAID_PAY_STATES } from "@/lib/constants";
import { contributorLabel } from "@/lib/assignees";
import { shortAddress } from "@/lib/format";
import type { BoardTask, MemberOption } from "@/lib/boardTypes";

export function RecognitionTaskPanel({
  task,
  members,
  canEndorse,
  canKudos,
  sessionWallet,
}: {
  task: BoardTask;
  members: MemberOption[];
  canEndorse: boolean;
  canKudos: boolean;
  sessionWallet: string | null;
}) {
  const paid = PAID_PAY_STATES.includes(task.pay_state);
  const events = useRecognitionTaskEvents(paid ? task.id : null, paid);
  const [note, setNote] = useState("");
  const action = useAsyncAction();

  if (!paid) return null;

  const active = (events.data?.events ?? []).filter((e) => e.revoked_at == null);
  const endorsedSubjects = new Set(
    active.filter((e) => e.kind === RecognitionKind.Endorsement).map((e) => e.subject_wallet),
  );
  const myKudos = new Set(
    active
      .filter((e) => e.kind === RecognitionKind.PeerKudos && e.actor_wallet === sessionWallet)
      .map((e) => e.subject_wallet),
  );
  const assignees = (task.task_assignees ?? [])
    .map((a) => a.wallet_address)
    .filter((w): w is string => !!w);

  const label = (wallet: string) => {
    const member = members.find((m) => m.wallet === wallet);
    return member
      ? contributorLabel(member)
      : shortAddress(wallet);
  };

  const endorse = (subjectWallet: string) => {
    void action.run(async () => {
      await apiFetch<RecognitionCreatedResponse>("/api/recognition/endorse", {
        method: "POST",
        body: { taskId: task.id, subjectWallet, note: note.trim() || undefined },
      });
      setNote("");
      events.reload();
    });
  };

  const kudos = (subjectWallet: string) => {
    void action.run(async () => {
      await apiFetch<RecognitionCreatedResponse>("/api/recognition/kudos", {
        method: "POST",
        body: { taskId: task.id, subjectWallet, note: note.trim() || undefined },
      });
      setNote("");
      events.reload();
    });
  };

  const revoke = (eventId: string) => {
    void action.run(async () => {
      await apiFetch("/api/recognition/revoke", {
        method: "POST",
        body: { eventId, reason: "Revoked from task" },
      });
      events.reload();
    });
  };

  return (
    <div className="space-y-3 rounded-md border border-zinc-800 bg-zinc-950/40 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <p className="text-sm font-medium text-zinc-200">Recognition</p>
        {events.data?.endorsementsRemaining != null && canEndorse && (
          <p className="text-xs text-zinc-500">
            {events.data.endorsementsRemaining} endorsement
            {events.data.endorsementsRemaining === 1 ? "" : "s"} left this season
          </p>
        )}
      </div>
      <ErrorText error={events.error ?? action.error} />
      {active.length > 0 && (
        <ul className="space-y-1 text-xs text-zinc-400">
          {active.map((e) => (
            <li key={e.id} className="flex flex-wrap items-center gap-2">
              <span>
                {e.kind === RecognitionKind.Endorsement ? "Endorsed" : "Kudos"}{" "}
                <span className="text-zinc-200">{label(e.subject_wallet)}</span>
                {" "}by {label(e.actor_wallet)}
                {e.note ? ` — ${e.note}` : ""}
              </span>
              {(sessionWallet === e.actor_wallet || canEndorse) && (
                <Button variant="ghost" className="!px-1 !py-0 text-xs" disabled={action.busy}
                  onClick={() => revoke(e.id)}>
                  Revoke
                </Button>
              )}
            </li>
          ))}
        </ul>
      )}
      {(canEndorse || canKudos) && assignees.some((w) => w !== sessionWallet) && (
        <>
          <Field label="Optional note" size="sm">
            <Input value={note} maxLength={500} onChange={(e) => setNote(e.target.value)}
              placeholder="Why this work stood out" />
          </Field>
          <ul className="space-y-2">
            {assignees.filter((w) => w !== sessionWallet).map((wallet) => (
              <li key={wallet} className="flex flex-wrap items-center gap-2 text-sm">
                <span className="min-w-0 flex-1 truncate text-zinc-300">{label(wallet)}</span>
                {canEndorse && !endorsedSubjects.has(wallet) && (
                  <Button variant="secondary" disabled={action.busy || (events.data?.endorsementsRemaining ?? 1) <= 0}
                    onClick={() => endorse(wallet)}>
                    Endorse
                  </Button>
                )}
                {canKudos && !myKudos.has(wallet) && (
                  <Button variant="ghost" disabled={action.busy} onClick={() => kudos(wallet)}>
                    Kudos
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </div>
  );
}
