"use client";

// Make a proposal of any kind the viewer may propose, except budgets (made
// from the Budgets page): a decision, a new workgroup, or a task on an app
// board. Shows the rules it will be decided by and about how many will vote.
// With reviseFrom, prefills from a discussion proposal and submits a linked
// replacement that withdraws it (0068).
import { useMemo, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { CreateProposalResponse, ElectoratePreviewResponse } from "@/lib/api/types";
import { adaLovelaceFromAmounts } from "@/lib/assets";
import { amountsFromRows, rewardRows, type AmountRow } from "@/lib/boardTypes";
import { MAX_PROPOSAL_BODY, MAX_PROPOSAL_TITLE, ProposalKind, Proposers, TaskSource } from "@/lib/constants";
import type { MemberWithContributor, ProposalRow } from "@/lib/db/types";
import { errorMessage } from "@/lib/errors";
import { noEligibleVotersReason } from "@/lib/governance/electorate";
import { KIND_LABELS, voterName } from "@/lib/governance/labels";
import { isTaskPayload, isWorkgroupPayload, taskExceedsLazyCap } from "@/lib/governance/payload";
import { rulesFor, sameRules } from "@/lib/governance/rules";
import { mayPropose } from "@/lib/roles";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useAsyncData } from "@/hooks/useAsyncData";
import type { GovernanceSettingsByKind } from "@/hooks/useProposals";
import type { WorkgroupSummary } from "@/hooks/useWorkgroups";
import { Button, ErrorText, Field, Input, Modal, Select, Textarea, WarningText } from "@/components/ui";
import { RewardRowsField } from "@/components/calls/RewardRowsField";
import { AdjustableProposalRules, useTrackedRules } from "./ProposalRulesEditor";
import { ProposalRulesSummary } from "./ProposalRulesSummary";

/** The kinds made from this dialog. */
export const DIALOG_KINDS = [ProposalKind.Decision, ProposalKind.Workgroup, ProposalKind.Task] as const;
export type DialogKind = (typeof DIALOG_KINDS)[number];

export interface ProposerRoles {
  isAdmin: boolean;
  ledWorkgroupIds: ReadonlySet<string>;
}

/** App boards a task may be proposed on by this viewer. */
export function taskBoards(workgroups: readonly WorkgroupSummary[], settings: GovernanceSettingsByKind, roles: ProposerRoles) {
  return workgroups.filter((w) => w.kind === TaskSource.Native && !w.archived_at &&
    mayPropose(roles, settings.task.proposers, [w.id]));
}

/** The kinds this viewer can propose from the dialog. */
export function proposableKinds(
  settings: GovernanceSettingsByKind, roles: ProposerRoles, workgroups: readonly WorkgroupSummary[],
): DialogKind[] {
  return DIALOG_KINDS.filter((kind) => settings[kind].enabled && (kind === ProposalKind.Task
    ? taskBoards(workgroups, settings, roles).length > 0
    : mayPropose(roles, settings[kind].proposers, [])));
}

function isDialogKind(kind: string): kind is DialogKind {
  return (DIALOG_KINDS as readonly string[]).includes(kind);
}

export function NewProposalDialog({
  communityId, kinds, initialKind, initialWorkgroupId, settings, roles, workgroups, members, sessionWallet,
  reviseFrom, onClose, onCreated,
}: {
  communityId: string;
  kinds: DialogKind[];
  initialKind?: DialogKind;
  initialWorkgroupId?: string;
  settings: GovernanceSettingsByKind;
  roles: ProposerRoles;
  workgroups: readonly WorkgroupSummary[];
  members: readonly MemberWithContributor[];
  sessionWallet: string | null;
  /** Prefill from this discussion proposal and replace it on submit (0068). */
  reviseFrom?: ProposalRow;
  onClose: () => void;
  onCreated: (proposalId: string) => void;
}) {
  const revising = !!reviseFrom;
  const [kind, setKind] = useState<DialogKind>(() => {
    if (reviseFrom && isDialogKind(reviseFrom.kind)) return reviseFrom.kind;
    return initialKind && kinds.includes(initialKind) ? initialKind : kinds[0]!;
  });
  const boards = useMemo(() => taskBoards(workgroups, settings, roles), [workgroups, settings, roles]);
  const taskPayload = reviseFrom && isTaskPayload(reviseFrom.payload) ? reviseFrom.payload.task : null;
  const workgroupPayload = reviseFrom && isWorkgroupPayload(reviseFrom.payload) ? reviseFrom.payload.workgroup : null;

  const [title, setTitle] = useState(reviseFrom && kind !== ProposalKind.Workgroup ? reviseFrom.title : "");
  const [body, setBody] = useState(reviseFrom?.body ?? "");
  const [discussionUrl, setDiscussionUrl] = useState(reviseFrom?.discussion_url ?? "");
  const [name, setName] = useState(workgroupPayload?.name ?? "");
  const [description, setDescription] = useState(workgroupPayload?.description ?? "");
  const [leads, setLeads] = useState<string[]>(
    workgroupPayload?.leads ?? (sessionWallet ? [sessionWallet] : []),
  );
  const [workgroupId, setWorkgroupId] = useState(() => {
    if (taskPayload && boards.some((b) => b.id === taskPayload.workgroupId)) return taskPayload.workgroupId;
    return boards.some((b) => b.id === initialWorkgroupId) ? initialWorkgroupId! : boards[0]?.id ?? "";
  });
  const [rows, setRows] = useState<AmountRow[]>(() => rewardRows(taskPayload?.amounts));
  const [assignSelf, setAssignSelf] = useState(taskPayload?.assignSelf ?? true);
  const create = useAsyncAction(revising ? "Failed to revise the proposal" : "Failed to make the proposal");

  // The bounty as the board stores it; null (and the error) while it is invalid.
  let amounts: Record<string, string> | null = null;
  let amountsError: string | null = null;
  try {
    amounts = amountsFromRows(rows);
  } catch (err) {
    amountsError = errorMessage(err, "Invalid bounty");
  }
  const communityBaseline = rulesFor(settings[kind], {
    escalate: kind === ProposalKind.Task && !!amounts &&
      taskExceedsLazyCap(amounts, adaLovelaceFromAmounts(amounts), settings.task.lazyCapLovelace),
  });
  // A revision keeps the frozen rules as its tracked baseline so community
  // defaults do not silently replace them.
  const baseline = reviseFrom?.rules ?? communityBaseline;
  const [rules, setRules] = useTrackedRules(baseline);
  // A task's rules stay the community's unless an admin or a lead of its board changes them.
  const mayAdjust = kind !== ProposalKind.Task || mayPropose(roles, Proposers.Managers, workgroupId ? [workgroupId] : []);
  const shown = mayAdjust ? rules : baseline;
  const customized = mayAdjust && !sameRules(rules, communityBaseline);
  const concerned = kind === ProposalKind.Task && workgroupId ? workgroupId : "";
  const beneficiaries = kind === ProposalKind.Workgroup
    ? leads
    : kind === ProposalKind.Task && assignSelf && sessionWallet ? [sessionWallet] : [];
  const electorate = useAsyncData(
    `${communityId}:${kind}:${concerned}:${shown.electorate}:${shown.activityMonths}:${shown.minMemberDays}:${shown.recuseBeneficiaries}:${beneficiaries.join(",")}`,
    () => apiFetch<ElectoratePreviewResponse>("/api/proposals/electorate", {
      query: {
        communityId, kind, workgroupIds: concerned || undefined,
        electorate: shown.electorate, activityMonths: shown.activityMonths, minMemberDays: shown.minMemberDays,
        recuseBeneficiaries: shown.recuseBeneficiaries,
        beneficiaries: beneficiaries.length ? beneficiaries.join(",") : undefined,
      },
    }));
  const blockedReason = electorate.data
    ? noEligibleVotersReason(electorate.data.count, electorate.data.eligible) : null;

  const ready = kind === ProposalKind.Workgroup
    ? !!name.trim()
    : kind === ProposalKind.Task ? !!title.trim() && !!workgroupId && !!amounts : !!title.trim();

  const defaultLeads = sessionWallet ? [sessionWallet] : [];
  const dirty = revising || !!(title.trim() || body.trim() || discussionUrl.trim() || name.trim() || description.trim()
    || !assignSelf || customized
    || leads.length !== defaultLeads.length || leads.some((w, i) => w !== defaultLeads[i])
    || rows.length !== 1 || rows[0]?.ticker !== "ADA" || rows[0]?.amount.trim());

  function requestClose() {
    if (create.busy) return;
    if (dirty && !window.confirm(revising
      ? "Discard this revision? The original proposal stays open."
      : "Discard this draft proposal?")) return;
    onClose();
  }

  async function submit() {
    const link = discussionUrl.trim() || null;
    // A revision always freezes the (possibly edited) rules from the dialog.
    const override = revising || customized ? { rules: shown } : {};
    const replace = revising ? { replacesProposalId: reviseFrom.id } : {};
    const request =
      kind === ProposalKind.Workgroup
        ? { kind, communityId, title: `New workgroup: ${name.trim()}`.slice(0, MAX_PROPOSAL_TITLE), body, discussionUrl: link,
          workgroup: { name: name.trim(), description, leads }, ...override, ...replace }
        : kind === ProposalKind.Task
          ? { kind, communityId, title: title.trim(), body, discussionUrl: link, task: { workgroupId, amounts: amounts!, assignSelf }, ...override, ...replace }
          : { kind, communityId, title: title.trim(), body, discussionUrl: link, ...override, ...replace };
    const created = await create.run(() => apiFetch<CreateProposalResponse>("/api/proposals", { body: request }));
    if (created) onCreated(created.id);
  }

  return (
    <Modal open onClose={requestClose} busy={create.busy} scroll
      title={revising ? `Revise proposal #${reviseFrom.number}` : "New proposal"} className="w-full max-w-2xl">
      <div className="space-y-4">
        {revising && (
          <p className="text-sm text-zinc-400">
            Submitting withdraws #{reviseFrom.number} and opens a new proposal with a fresh discussion period.
            Closing this dialog without submitting leaves #{reviseFrom.number} open.
          </p>
        )}
        {!revising && kinds.length > 1 && (
          <Field label="Kind">
            <Select aria-label="Proposal kind" value={kind} onChange={(e) => setKind(e.target.value as DialogKind)}>
              {kinds.map((k) => <option key={k} value={k}>{KIND_LABELS[k]}</option>)}
            </Select>
          </Field>
        )}

        {kind === ProposalKind.Workgroup && (
          <>
            <Field label="Workgroup name">
              <Input aria-label="Workgroup name" value={name} maxLength={80} onChange={(e) => setName(e.target.value)} />
            </Field>
            <Field label="What it does" hint="Becomes the workgroup's description.">
              <Textarea aria-label="Workgroup description" value={description} maxLength={1000} rows={3}
                onChange={(e) => setDescription(e.target.value)} />
            </Field>
            <Field label="Leads" hint="They manage its board and budget once it exists. Admins can change them later.">
              <div className="max-h-40 space-y-1 overflow-y-auto rounded-xl bg-zinc-800/60 p-2">
                {members.map((m) => (
                  <label key={m.wallet_address} className="flex items-center gap-2 text-sm">
                    <input type="checkbox" checked={leads.includes(m.wallet_address)}
                      onChange={(e) => setLeads((current) => e.target.checked
                        ? [...current, m.wallet_address]
                        : current.filter((w) => w !== m.wallet_address))} />
                    {voterName(m.wallet_address, m.contributors?.handle)}
                    {m.wallet_address === sessionWallet && <span className="text-xs text-zinc-500">(you)</span>}
                  </label>
                ))}
              </div>
            </Field>
            <Field label="Why (optional)" hint="What the workgroup is for and why the community needs it.">
              <Textarea aria-label="Rationale" value={body} maxLength={MAX_PROPOSAL_BODY} rows={4} onChange={(e) => setBody(e.target.value)} />
            </Field>
          </>
        )}

        {kind === ProposalKind.Task && (
          <>
            <Field label="Board">
              <Select aria-label="Board" value={workgroupId} onChange={(e) => setWorkgroupId(e.target.value)} disabled={revising}>
                {boards.map((b) => <option key={b.id} value={b.id}>{b.name}</option>)}
              </Select>
            </Field>
            <Field label="Task title">
              <Input aria-label="Task title" value={title} maxLength={MAX_PROPOSAL_TITLE} onChange={(e) => setTitle(e.target.value)} />
            </Field>
            <Field label="What needs doing" hint="Becomes the task's description.">
              <Textarea aria-label="Task description" value={body} maxLength={MAX_PROPOSAL_BODY} rows={5} onChange={(e) => setBody(e.target.value)} />
            </Field>
            <RewardRowsField rows={rows} onChange={setRows} label="Bounty"
              hint="Each assignee receives the full amount. A ticker is matched to a treasury token at payout." />
            <ErrorText error={rows.some((r) => r.amount.trim()) ? amountsError : null} />
            <label className="flex items-center gap-2 text-sm">
              <input type="checkbox" checked={assignSelf} onChange={(e) => setAssignSelf(e.target.checked)} />
              Assign the task to me
            </label>
          </>
        )}

        {kind === ProposalKind.Decision && (
          <>
            <Field label="Title">
              <Input aria-label="Proposal title" value={title} maxLength={MAX_PROPOSAL_TITLE} onChange={(e) => setTitle(e.target.value)}
                placeholder="Adopt a code of conduct" />
            </Field>
            <Field label="What members vote on" hint={revising
              ? "State the decision so a yes or a no is unambiguous."
              : "State the decision so a yes or a no is unambiguous. Use Revise during discussion to change it."}>
              <Textarea aria-label="Proposal text" value={body} maxLength={MAX_PROPOSAL_BODY} rows={7} onChange={(e) => setBody(e.target.value)} />
            </Field>
          </>
        )}

        <Field label="Discussion link (optional)" hint="Where members discuss it: a forum thread, a Discord channel.">
          <Input aria-label="Discussion link" value={discussionUrl} placeholder="https://" onChange={(e) => setDiscussionUrl(e.target.value)} />
        </Field>
        {mayAdjust ? (
          <AdjustableProposalRules kind={kind} rules={rules} baseline={communityBaseline} onChange={setRules}>
            <ProposalRulesSummary rules={shown} electorate={electorate.data?.eligible} estimate />
          </AdjustableProposalRules>
        ) : (
          <div className="rounded-xl bg-zinc-800/60 p-3">
            <ProposalRulesSummary rules={shown} electorate={electorate.data?.eligible} estimate />
          </div>
        )}
        <WarningText>{blockedReason}</WarningText>
        <ErrorText error={create.error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={requestClose} disabled={create.busy}>Cancel</Button>
          <Button loading={create.busy} disabled={!ready || blockedReason !== null} onClick={() => void submit()}>
            {revising ? "Submit revision" : "Make proposal"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}
