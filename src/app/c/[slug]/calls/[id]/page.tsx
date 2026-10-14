"use client";

import { use, useMemo, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api/client";
import type { AddAttendeesBody, PatchAttendeeBody } from "@/lib/api/schemas";
import type { AddAttendeesResponse, FinalizeCallResponse } from "@/lib/api/types";
import { contributorLabel } from "@/lib/assignees";
import { toMemberOptions } from "@/lib/boardTypes";
import { chunkSizes } from "@/lib/calls/chunk";
import { countStandings } from "@/lib/calls/qualify";
import {
  type AttendeeStatus,
  CALL_PROVIDER_LABELS,
  CallProvider,
  MAX_TASK_ASSIGNEES,
  PAID_PAY_STATES,
} from "@/lib/constants";
import type { CallAttendee } from "@/lib/db/types";
import { formatDate, plural } from "@/lib/format";
import { routes } from "@/lib/routes";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useCall } from "@/hooks/useCalls";
import { useCommunityGate } from "@/hooks/useCommunityGate";
import { useCommunityMembers } from "@/hooks/useCommunityMembers";
import { useMyTreasuryRoles } from "@/hooks/useMyTreasuryRoles";
import { AttendeeTable } from "@/components/calls/AttendeeTable";
import { CallFormDialog } from "@/components/calls/CallFormDialog";
import { CapturePanel } from "@/components/calls/CapturePanel";
import { CheckinPanel } from "@/components/calls/CheckinPanel";
import { MeetingCaptureNote } from "@/components/calls/MeetingCaptureNote";
import { LinkWalletDialog } from "@/components/calls/LinkWalletDialog";
import { PasteAttendeesDialog } from "@/components/calls/PasteAttendeesDialog";
import {
  Badge,
  Button,
  CallStateBadge,
  Card,
  ConfirmDialog,
  ErrorText,
  InsetRow,
  NoticeText,
  PageMessage,
  PageTitle,
  SectionTitle,
  Select,
} from "@/components/ui";
import { managesWorkgroup } from "@/lib/roles";

type Dialog = "edit" | "paste" | "finalize" | "delete" | null;

export default function CallPage({ params }: { params: Promise<{ slug: string; id: string }> }) {
  const { slug, id } = use(params);
  const router = useRouter();
  const { community, isAdmin, blocked } = useCommunityGate(slug);
  const callQuery = useCall(community ? id : null);
  const members = useCommunityMembers(community?.id);
  const roles = useMyTreasuryRoles(community?.id);
  const action = useAsyncAction();
  const [dialog, setDialog] = useState<Dialog>(null);
  const [linking, setLinking] = useState<CallAttendee | null>(null);
  const [memberToAdd, setMemberToAdd] = useState("");
  const [notice, setNotice] = useState<string | null>(null);

  const call = callQuery.data;
  const memberOptions = useMemo(() => toMemberOptions(members.data ?? []), [members.data]);
  const attendees = useMemo(() => call?.call_attendees ?? [], [call]);
  const taskNumbers = useMemo(
    () => new Map((call?.call_tasks ?? []).flatMap((t) => (t.tasks ? [[t.task_id, t.tasks.number] as const] : []))),
    [call],
  );

  if (blocked) return blocked;
  if (!call) {
    return callQuery.loading ? <></> : <PageMessage>{callQuery.error ?? "Call not found"}</PageMessage>;
  }

  const archived = !!call.workgroups?.archived_at;
  const canManage = !archived && managesWorkgroup({ isAdmin, ...roles }, call.workgroup_id);
  const counts = countStandings(call, attendees);
  const sizes = chunkSizes(counts.ready, MAX_TASK_ASSIGNEES);
  const onList = new Set(attendees.map((a) => a.wallet_address));
  const addable = memberOptions.filter((m) => !onList.has(m.wallet));
  const attendeesPath = `/api/calls/${call.id}/attendees`;

  async function mutate(task: () => Promise<unknown>, done?: string) {
    setNotice(null);
    const ok = await action.run(async () => {
      await task();
      return true;
    });
    if (ok) {
      callQuery.reload();
      if (done) setNotice(done);
    }
  }

  const setStatus = (a: CallAttendee, status: AttendeeStatus) =>
    mutate(() => apiFetch(attendeesPath, {
      method: "PATCH", body: { attendeeId: a.id, status } satisfies PatchAttendeeBody,
    }));

  const remove = (a: CallAttendee) =>
    mutate(() => apiFetch(attendeesPath, { method: "DELETE", body: { attendeeId: a.id } }));

  const addMember = () =>
    mutate(async () => {
      await apiFetch(attendeesPath, { body: { kind: "wallet", wallet: memberToAdd } satisfies AddAttendeesBody });
      setMemberToAdd("");
    });

  async function finalize() {
    setNotice(null);
    const result = await action.run(() =>
      apiFetch<FinalizeCallResponse>(`/api/calls/${call!.id}/finalize`, { method: "POST" }),
    );
    if (!result) return;
    setDialog(null);
    callQuery.reload();
    const tasks = result.taskIds.length;
    setNotice(
      `${plural(result.paid, "attendee")} placed on ${plural(tasks, "task")}. ` +
        "They are payable on Payday now.",
    );
  }

  async function deleteCall() {
    const ok = await action.run(() => apiFetch(`/api/calls/${call!.id}`, { method: "DELETE" }));
    if (ok) router.push(routes.calls(slug));
  }

  function pasted(result: AddAttendeesResponse) {
    setDialog(null);
    callQuery.reload();
    setNotice(
      `Added ${result.added} (${result.matched} linked to a wallet)` +
        (result.skipped > 0 ? `, skipped ${result.skipped} already on the list.` : "."),
    );
  }

  return (
    <div>
      <PageTitle
        action={canManage && (
          <div className="flex flex-wrap gap-2">
            <Button variant="secondary" onClick={() => setDialog("edit")}>Edit</Button>
            {call.call_tasks.length === 0 && (
              <Button variant="ghost" onClick={() => setDialog("delete")}>Delete</Button>
            )}
          </div>
        )}
      >
        {call.title}
      </PageTitle>
      <p className="-mt-3 mb-6 flex flex-wrap items-center gap-2 text-sm text-zinc-400">
        <span>
          {formatDate(call.starts_at, "datetime")} · {CALL_PROVIDER_LABELS[call.provider]} · {call.workgroups?.name}
        </span>
        <CallStateBadge state={call.state} />
        {archived && <Badge tone="yellow">Workgroup archived</Badge>}
      </p>

      <div className="mb-6 grid gap-4 lg:grid-cols-2">
        <Card>
          <SectionTitle>Reward</SectionTitle>
          <p className="text-sm text-zinc-400">
            Each rewarded attendee receives{" "}
            {Object.entries(call.amounts).map(([ticker, amount], i) => (
              <span key={ticker} className="font-medium text-zinc-100">{i > 0 && " + "}{amount} {ticker}</span>
            ))}
            , paid from the {call.workgroups?.name} workgroup&apos;s budget and wallet.
          </p>
          {call.call_tasks.length > 0 && (
            <div className="mt-4 space-y-2">
              {[...call.call_tasks].sort((a, b) => a.chunk_index - b.chunk_index).map((t) => (
                <InsetRow key={t.task_id}>
                  <span className="min-w-0 truncate text-sm">
                    <span className="text-zinc-500">#{t.tasks?.number}</span> {t.tasks?.title}
                  </span>
                  <Badge tone={t.tasks && PAID_PAY_STATES.includes(t.tasks.pay_state) ? "green" : "blue"}>
                    {t.tasks?.pay_state ?? "task"}
                  </Badge>
                </InsetRow>
              ))}
              <Link href={routes.payday(slug)} className="inline-block text-sm text-indigo-400 hover:underline">
                Pay them on Payday
              </Link>
            </div>
          )}
        </Card>
        {canManage && <CheckinPanel slug={slug} call={call} />}
        <MeetingCaptureNote call={call} />
        {call.provider === CallProvider.Discord && (
          <CapturePanel call={call} snapshots={call.call_snapshots} canManage={canManage}
            onCaptured={(result) => {
              callQuery.reload();
              setNotice(`Snapshot taken: ${result.present} in the channel, ${result.added} new to the list.`);
            }} />
        )}
      </div>

      <SectionTitle
        action={canManage && (
          <div className="flex flex-wrap items-center gap-2">
            {addable.length > 0 && (
              <>
                <Select aria-label="Add a member" className="!w-48" value={memberToAdd}
                  onChange={(e) => setMemberToAdd(e.target.value)}>
                  <option value="">Add a member…</option>
                  {addable.map((m) => (
                    <option key={m.wallet} value={m.wallet}>{contributorLabel(m)}</option>
                  ))}
                </Select>
                <Button variant="secondary" disabled={!memberToAdd || action.busy} onClick={() => void addMember()}>
                  Add
                </Button>
              </>
            )}
            <Button variant="secondary" onClick={() => setDialog("paste")}>Paste a list</Button>
            <Button disabled={counts.ready === 0 || action.busy} onClick={() => setDialog("finalize")}>
              Create attendance task{sizes.length > 1 ? "s" : ""}
            </Button>
          </div>
        )}
      >
        Attendees ({attendees.length})
      </SectionTitle>
      <p className="mb-3 text-xs text-zinc-500">
        {counts.ready} ready · {counts.unlinked} without a wallet · {counts.rewarded} on a task
        {counts["below-threshold"] > 0 && ` · ${counts["below-threshold"]} below the threshold`}
        {counts.excluded > 0 && ` · ${counts.excluded} excluded`}
      </p>
      <ErrorText error={dialog ? null : action.error} className="mb-3" />
      <NoticeText className="mb-3">{notice}</NoticeText>
      <AttendeeTable call={call} attendees={attendees} taskNumbers={taskNumbers} canManage={canManage}
        busy={action.busy} onLink={setLinking} onStatus={(a, s) => void setStatus(a, s)}
        onRemove={(a) => void remove(a)} />

      {dialog === "edit" && (
        <CallFormDialog open slug={slug} communityId={call.community_id} call={call} workgroups={[]} rewardLocked={call.call_tasks.length > 0}
          onClose={() => setDialog(null)}
          onSaved={() => {
            setDialog(null);
            callQuery.reload();
          }} />
      )}
      {dialog === "paste" && (
        <PasteAttendeesDialog callId={call.id} onClose={() => setDialog(null)} onAdded={pasted} />
      )}
      {linking && (
        <LinkWalletDialog callId={call.id} attendee={linking} members={memberOptions}
          onClose={() => setLinking(null)}
          onSaved={() => {
            setLinking(null);
            callQuery.reload();
          }} />
      )}
      <ConfirmDialog open={dialog === "finalize"} danger={false} busy={action.busy} error={action.error}
        title="Create attendance tasks" confirmLabel="Create"
        onCancel={() => setDialog(null)} onConfirm={() => void finalize()}>
        <p>
          {counts.ready === 1 ? "1 attendee goes" : `${counts.ready} attendees go`} on{" "}
          {sizes.length === 1 ? "one payable task" : `${sizes.length} payable tasks (${sizes.join(" + ")} people)`}{" "}
          in {call.workgroups?.name}. Each receives the full reward when the task is paid on Payday.
        </p>
        {counts.unlinked > 0 && (
          <p className="mt-2">
            {counts.unlinked} without a wallet stay on the list: link them later and create another task.
          </p>
        )}
      </ConfirmDialog>
      <ConfirmDialog open={dialog === "delete"} busy={action.busy} error={action.error}
        title="Delete this call?" confirmLabel="Delete"
        onCancel={() => setDialog(null)} onConfirm={() => void deleteCall()}>
        The call and its attendee list are removed. Nothing has been paid from it.
      </ConfirmDialog>
      {!canManage && !archived && (
        <p className="mt-6 text-xs text-zinc-500">
          Admins and the leads of {call.workgroups?.name} manage this call.
        </p>
      )}
    </div>
  );
}
