"use client";

// With budget consent on, the worksheet's changes become one proposal: a
// title, the rationale members vote on, and the rules it will be decided by.
import { useState } from "react";
import { MAX_PROPOSAL_BODY, MAX_PROPOSAL_TITLE } from "@/lib/constants";
import { truncate } from "@/lib/format";
import { rulesFor, type GovernanceSettings } from "@/lib/governance/rules";
import { ProposalRulesSummary } from "@/components/governance/ProposalRulesSummary";
import { Button, ErrorText, Field, Input, Modal, Textarea } from "@/components/ui";

export interface BudgetProposalText {
  title: string;
  body: string;
  discussionUrl: string | null;
}

export function ProposeBudgetDialog({ projectNames, settings, busy, error, onClose, onSubmit }: {
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
        <div className="rounded-xl bg-zinc-800/60 p-3">
          <ProposalRulesSummary rules={rulesFor(settings)} />
        </div>
        <ErrorText error={error} />
        <div className="flex justify-end gap-2">
          <Button variant="secondary" onClick={onClose} disabled={busy}>Back to editing</Button>
          <Button loading={busy} disabled={!title.trim()}
            onClick={() => onSubmit({ title: title.trim(), body: body.trim(), discussionUrl: discussionUrl.trim() || null })}>
            Make proposal
          </Button>
        </div>
      </div>
    </Modal>
  );
}
