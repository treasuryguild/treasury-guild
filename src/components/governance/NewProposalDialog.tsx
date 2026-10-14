"use client";

// Make a proposal of any kind the viewer may propose, except budgets (made
// from the Budgets page): a decision, a new workgroup, or a task on an app
// board. Shows the rules it will be decided by and about how many will vote.
import { useMemo, useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { CreateProposalResponse, ElectoratePreviewResponse } from "@/lib/api/types";
import { adaLovelaceFromAmounts } from "@/lib/assets";
import { amountsFromRows, type AmountRow } from "@/lib/boardTypes";
import { MAX_PROPOSAL_BODY, MAX_PROPOSAL_TITLE, ProposalKind, TaskSource } from "@/lib/constants";
import { errorMessage } from "@/lib/errors";
import { KIND_LABELS, voterName } from "@/lib/governance/labels";
import { taskExceedsLazyCap } from "@/lib/governance/payload";
import { rulesFor } from "@/lib/governance/rules";
import type { MemberWithContributor } from "@/lib/db/types";
import { mayPropose } from "@/lib/roles";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useAsyncData } from "@/hooks/useAsyncData";
import type { GovernanceSettingsByKind } from "@/hooks/useProposals";
import type { WorkgroupSummary } from "@/hooks/useWorkgroups";
import { Button, ErrorText, Field, Input, Modal, Select, Textarea } from "@/components/ui";
import { RewardRowsField } from "@/components/calls/RewardRowsField";
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

export function NewProposalDialog({
  communityId, kinds, initialKind, initialWorkgroupId, settings, roles, workgroups, members, sessionWallet, onClose, onCreated,
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
  onClose: () => void;
  onCreated: (proposalId: string) => void;
}) {
  const [kind, setKind] = useState<DialogKind>(initialKind && kinds.includes(initialKind) ? initialKind : kinds[0]!);
  const boards = useMemo(() => taskBoards(workgroups, settings, roles), [workgroups, settings, roles]);
  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [discussionUrl, setDiscussionUrl] = useState("");
  const [name, setName] = useState("");
  const [description, setDescription] = useState("");
  const [leads, setLeads] = useState<string[]>(sessionWallet ? [sessionWallet] : []);
  const [workgroupId, setWorkgroupId] = useState(
    boards.some((b) => b.id === initialWorkgroupId) ? initialWorkgroupId! : boards[0]?.id ?? "",
  );
  const [rows, setRows] = useState<AmountRow[]>([{ ticker: "ADA", amount: "" }]);
  const [assignSelf, setAssignSelf] = useState(true);
  const create = useAsyncAction("Failed to make the proposal");

  // The bounty as the board stores it; null (and the error) while it is invalid.
  let amounts: Record<string, string> | null = null;
  let amountsError: string | null = null;
  try {
    amounts = amountsFromRows(rows);
  } catch (err) {
    amountsError = errorMessage(err, "Invalid bounty");
  }
  const rules = rulesFor(settings[kind], {
    escalate: kind === ProposalKind.Task && !!amounts &&
      taskExceedsLazyCap(amounts, adaLovelaceFromAmounts(amounts), settings.task.lazyCapLovelace),
  });
  const concerned = kind === ProposalKind.Task && workgroupId ? workgroupId : "";
  const electorate = useAsyncData(`${communityId}:${kind}:${concerned}`, () =>
    apiFetch<ElectoratePreviewResponse>("/api/proposals/electorate", {
      query: { communityId, kind, workgroupIds: concerned || undefined },
    }));

  const ready = kind === ProposalKind.Workgroup
    ? !!name.trim()
    : kind === ProposalKind.Task ? !!title.trim() && !!workgroupId && !!amounts : !!title.trim();

  async function submit() {
    const link = discussionUrl.trim() || null;
    const request =
      kind === ProposalKind.Workgroup
        ? { kind, communityId, title: `New workgroup: ${name.trim()}`.slice(0, MAX_PROPOSAL_TITLE), body, discussionUrl: link,
          workgroup: { name: name.trim(), description, leads } }
        : kind === ProposalKind.Task
          ? { kind, communityId, title: title.trim(), body, discussionUrl: link, task: { workgroupId, amounts: amounts!, assignSelf } }
          : { kind, communityId, title: title.trim(), body, discussionUrl: link };
    const created = await create.run(() => apiFetch<CreateProposalResponse>("/api/proposals", { body: request }));
    if (created) onCreated(created.id);
  }

  return (
    <Modal open onClose={onClose} busy={create.busy} scroll title="New proposal" className="w-full max-w-2xl">
      <div className="space-y-4">
        {kinds.length > 1 && (
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
              <Select aria-label="Board" value={workgroupId} onChange={(e) => setWorkgroupId(e.target.value)}>
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
            <Field label="What members vote on" hint="State the decision so a yes or a no is unambiguous. It cannot be edited once made.">
              <Textarea aria-label="Proposal text" value={body} maxLength={MAX_PROPOSAL_BODY} rows={7} onChange={(e) => setBody(e.target.value)} />
            </Field>
          </>
        )}

        <Field label="Discussion link (optional)" hint="Where members discuss it: a forum thread, a Discord channel.">
          <Input aria-label="Discussion link" value={discussionUrl} placeholder="https://" onChange={(e) => setDiscussionUrl(e.target.value)} />
        </Field>
        <div className="rounded-xl bg-zinc-800/60 p-3">
          <ProposalRulesSummary rules={rules} electorate={electorate.data?.count} estimate />
        </div>
        <ErrorText error={create.error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={create.busy}>Cancel</Button>
          <Button loading={create.busy} disabled={!ready} onClick={() => void submit()}>Make proposal</Button>
        </div>
      </div>
    </Modal>
  );
}
