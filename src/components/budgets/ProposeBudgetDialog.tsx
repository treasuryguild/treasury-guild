"use client";

// With budget consent on, the worksheet's changes become one proposal: a
// title, the rationale members vote on, and the rules it will be decided by.
import { useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { ElectoratePreviewResponse } from "@/lib/api/types";
import { MAX_PROPOSAL_BODY, MAX_PROPOSAL_TITLE, ProposalKind } from "@/lib/constants";
import { truncate } from "@/lib/format";
import { noEligibleVotersReason } from "@/lib/governance/electorate";
import { rulesFor, sameRules, type GovernanceSettings, type ProposalRules } from "@/lib/governance/rules";
import { useAsyncData } from "@/hooks/useAsyncData";
import { AdjustableProposalRules, useTrackedRules } from "@/components/governance/ProposalRulesEditor";
import { ProposalRulesSummary } from "@/components/governance/ProposalRulesSummary";
import { Button, ErrorText, Field, Input, Modal, Textarea, WarningText } from "@/components/ui";

export interface BudgetProposalText {
  title: string;
  body: string;
  discussionUrl: string | null;
  /** Set only when the proposer changed the community's rules for this proposal. */
  rules?: ProposalRules;
}

export function ProposeBudgetDialog({
  communityId, workgroupIds, projectNames, settings, busy, error, onClose, onSubmit,
}: {
  communityId: string;
  /** Workgroups whose budgets this proposal changes. Their leads are recused when the rules say so. */
  workgroupIds: readonly string[];
  projectNames: string[];
  settings: GovernanceSettings;
  busy: boolean;
  error: string | null;
  onClose: () => void;
  onSubmit: (text: BudgetProposalText) => void;
}) {
  const [title, setTitle] = useState(truncate(`Budget changes: ${projectNames.join(", ")}`, MAX_PROPOSAL_TITLE));
  const [body, setBody] = useState("");
  const [discussionUrl, setDiscussionUrl] = useState("");
  const baseline = rulesFor(settings);
  const [rules, setRules] = useTrackedRules(baseline);
  const customized = !sameRules(rules, baseline);
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

  return (
    <Modal open onClose={onClose} busy={busy} scroll title="Propose budget changes" className="w-full max-w-2xl">
      <div className="space-y-4">
        <p className="text-sm text-zinc-400">
          Budget consent is on: these changes to {projectNames.length === 1 ? "1 project" : `${projectNames.length} projects`} go
          to a vote and apply together when it passes. Until then their budgets are locked.
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
        <AdjustableProposalRules kind="budget" rules={rules} baseline={baseline} onChange={setRules}>
          <ProposalRulesSummary rules={rules} electorate={electorate.data?.eligible} estimate />
        </AdjustableProposalRules>
        <WarningText>{blockedReason}</WarningText>
        <ErrorText error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Back to editing</Button>
          <Button loading={busy} disabled={!title.trim() || blockedReason !== null}
            onClick={() => onSubmit({
              title: title.trim(), body: body.trim(), discussionUrl: discussionUrl.trim() || null,
              ...(customized ? { rules } : {}),
            })}>
            Make proposal
          </Button>
        </div>
      </div>
    </Modal>
  );
}
