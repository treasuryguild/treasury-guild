"use client";

// Revise a budget proposal still in discussion: edit title, rationale,
// discussion link and rules; resubmit the same budget steps. Amount edits
// stay on the Budgets page after a plain withdraw (0068).
import { useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { CreateProposalResponse, ElectoratePreviewResponse } from "@/lib/api/types";
import { MAX_PROPOSAL_BODY, MAX_PROPOSAL_TITLE, ProposalKind } from "@/lib/constants";
import type { ProposalBudgetOwnerRow, ProposalRow } from "@/lib/db/types";
import { noEligibleVotersReason } from "@/lib/governance/electorate";
import { budgetOwnerKey, isBudgetPayload, savesFromBudgetSteps } from "@/lib/governance/payload";
import { rulesFor, sameRules, type GovernanceSettings } from "@/lib/governance/rules";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useAsyncData } from "@/hooks/useAsyncData";
import { AdjustableProposalRules, useTrackedRules } from "./ProposalRulesEditor";
import { ProposalRulesSummary } from "./ProposalRulesSummary";
import { Button, ErrorText, Field, Input, Modal, Textarea, WarningText } from "@/components/ui";

export function ReviseBudgetDialog({
  communityId, proposal, budgetOwners, settings, onClose, onCreated,
}: {
  communityId: string;
  proposal: ProposalRow;
  budgetOwners: readonly ProposalBudgetOwnerRow[];
  settings: GovernanceSettings;
  onClose: () => void;
  onCreated: (proposalId: string) => void;
}) {
  const [title, setTitle] = useState(proposal.title);
  const [body, setBody] = useState(proposal.body);
  const [discussionUrl, setDiscussionUrl] = useState(proposal.discussion_url ?? "");
  const communityBaseline = rulesFor(settings);
  const [rules, setRules] = useTrackedRules(proposal.rules);
  const create = useAsyncAction("Failed to revise the proposal");

  const workgroupIds = proposal.workgroup_ids;
  const electorate = useAsyncData(
    `${communityId}:${workgroupIds.join(",")}:${rules.electorate}:${rules.activityMonths}:${rules.minMemberDays}:${rules.recuseBeneficiaries}`,
    () => apiFetch<ElectoratePreviewResponse>("/api/proposals/electorate", {
      query: {
        communityId, kind: ProposalKind.Budget,
        workgroupIds: workgroupIds.length ? workgroupIds.join(",") : undefined,
        electorate: rules.electorate, activityMonths: rules.activityMonths, minMemberDays: rules.minMemberDays,
        recuseBeneficiaries: rules.recuseBeneficiaries,
      },
    }),
  );
  const blockedReason = electorate.data ? noEligibleVotersReason(electorate.data.count, electorate.data.eligible) : null;
  const steps = isBudgetPayload(proposal.payload) ? proposal.payload.steps : [];

  function requestClose() {
    if (create.busy) return;
    if (!window.confirm("Discard this revision? The original proposal stays open.")) return;
    onClose();
  }

  async function submit() {
    const revisions = new Map(
      budgetOwners.map((o) => [budgetOwnerKey({ workgroupId: o.workgroup_id, treasuryId: o.treasury_id }), o.base_revision]),
    );
    const saves = savesFromBudgetSteps(steps, revisions);
    const created = await create.run(() => apiFetch<CreateProposalResponse>("/api/proposals", {
      body: {
        kind: ProposalKind.Budget,
        communityId,
        title: title.trim(),
        body: body.trim(),
        discussionUrl: discussionUrl.trim() || null,
        rules,
        saves,
        replacesProposalId: proposal.id,
      },
    }));
    if (created) onCreated(created.id);
  }

  return (
    <Modal open onClose={requestClose} busy={create.busy} scroll
      title={`Revise proposal #${proposal.number}`} className="w-full max-w-2xl">
      <div className="space-y-4">
        <p className="text-sm text-zinc-400">
          Submitting withdraws #{proposal.number} and opens a new proposal with a fresh discussion period.
          Budget amounts stay as in #{proposal.number}. To change amounts, withdraw and propose again from the Budgets page.
        </p>
        <Field label="Title">
          <Input aria-label="Proposal title" value={title} maxLength={MAX_PROPOSAL_TITLE} onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="Why (optional)" hint="What the money is for and why this amount. Members read this before they vote.">
          <Textarea aria-label="Rationale" value={body} rows={5} maxLength={MAX_PROPOSAL_BODY} onChange={(e) => setBody(e.target.value)} />
        </Field>
        <Field label="Discussion link (optional)">
          <Input aria-label="Discussion link" value={discussionUrl} placeholder="https://" onChange={(e) => setDiscussionUrl(e.target.value)} />
        </Field>
        <AdjustableProposalRules kind="budget" rules={rules} baseline={communityBaseline} onChange={setRules}>
          <ProposalRulesSummary rules={rules} electorate={electorate.data?.eligible} estimate />
        </AdjustableProposalRules>
        {!sameRules(rules, proposal.rules) && (
          <p className="text-xs text-zinc-500">Rules differ from the original proposal.</p>
        )}
        <WarningText>{blockedReason}</WarningText>
        <ErrorText error={create.error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={requestClose} disabled={create.busy}>Cancel</Button>
          <Button loading={create.busy} disabled={!title.trim() || blockedReason !== null || steps.length === 0}
            onClick={() => void submit()}>
            Submit revision
          </Button>
        </div>
      </div>
    </Modal>
  );
}
