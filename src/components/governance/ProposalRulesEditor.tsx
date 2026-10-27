"use client";

// The voting rules frozen onto a proposal: the same fields the Governance
// page edits for a kind, without who may propose or the task lazy-consensus
// cap (those stay community policy). The settings card uses it directly. The
// create dialogs wrap it in AdjustableProposalRules, collapsed until someone
// wants this one proposal to differ.
import { useState, type ReactNode } from "react";
import {
  DecisionMethod, Electorate, ProposalKind, type DecisionMethod as Method,
} from "@/lib/constants";
import {
  describeHours, describeRulesChanges, ELECTORATE_LABELS, METHOD_HELP, METHOD_LABELS,
} from "@/lib/governance/labels";
import { canonicalJson, type ProposalRules } from "@/lib/governance/rules";
import { Button, Field, Input, Select } from "@/components/ui";

const RECUSE_TEXT: Partial<Record<ProposalKind, { label: string; help: string }>> = {
  [ProposalKind.Budget]: {
    label: "Recuse the leads of budgeted workgroups",
    help: "They do not vote on their own budgets and are not counted for the quorum.",
  },
  [ProposalKind.Workgroup]: {
    label: "Recuse the proposed leads",
    help: "They do not vote on the workgroup they would lead.",
  },
  [ProposalKind.Task]: {
    label: "Recuse a proposer who assigns the task to themselves",
    help: "They do not vote on a bounty they would be paid.",
  },
};

function NumberField({ label, value, min, max, disabled, hint, onChange }: {
  label: string; value: number; min: number; max: number; disabled: boolean; hint?: string; onChange: (value: number) => void;
}) {
  return (
    <Field label={label} hint={hint} size="sm">
      <Input type="number" aria-label={label} min={min} max={max} value={value} disabled={disabled}
        onChange={(e) => onChange(Math.max(min, Math.min(max, Math.trunc(Number(e.target.value) || 0))))} />
    </Field>
  );
}

/**
 * The rules a create dialog is editing. They follow `baseline` (the community
 * default, including a task escalated above the lazy cap) until the proposer
 * changes something; after that they stay put when the default moves.
 */
export function useTrackedRules(baseline: ProposalRules): [ProposalRules, (rules: ProposalRules) => void] {
  const baselineKey = canonicalJson(baseline);
  const [followedKey, setFollowedKey] = useState(baselineKey);
  const [rules, setRules] = useState(baseline);
  // The default moved (another kind, or a task bounty crossing the cap). Follow
  // it while the proposer has not diverged; otherwise keep what they chose.
  if (baselineKey !== followedKey) {
    setFollowedKey(baselineKey);
    if (canonicalJson(rules) === followedKey) setRules(baseline);
  }
  return [rules, setRules];
}

export function ProposalRulesEditor({
  kind, rules, disabled = false, onChange, leading, afterMethod,
}: {
  kind: ProposalKind;
  rules: ProposalRules;
  disabled?: boolean;
  onChange: (rules: ProposalRules) => void;
  /** First cell of the field grid. The settings card puts "who can propose" here. */
  leading?: ReactNode;
  /** Cells after the method's numbers and before the periods. The settings card puts the task cap here. */
  afterMethod?: ReactNode;
}) {
  const set = <K extends keyof ProposalRules>(key: K, value: ProposalRules[K]) => onChange({ ...rules, [key]: value });
  const windowed = rules.electorate === Electorate.Workgroup || rules.electorate === Electorate.Contributors;
  const recuse = RECUSE_TEXT[kind];

  return (
    <div className="space-y-4">
      <div className="grid gap-4 sm:grid-cols-2">
        {leading}
        <Field label="Who votes" size="sm" hint={rules.electorate === Electorate.Workgroup
          ? "Leads, recently paid contributors and assignees of the workgroups a proposal concerns; recently paid contributors when it concerns none."
          : undefined}>
          <Select aria-label="Who votes" value={rules.electorate} disabled={disabled}
            onChange={(e) => set("electorate", e.target.value as Electorate)}>
            {Object.values(Electorate).map((electorate) => (
              <option key={electorate} value={electorate}>{ELECTORATE_LABELS[electorate]}</option>
            ))}
          </Select>
        </Field>
        {windowed && (
          <NumberField label="Look back (months)" value={rules.activityMonths} min={1} max={36} disabled={disabled}
            onChange={(v) => set("activityMonths", v)} />
        )}
        <NumberField label="Minimum membership (days)" value={rules.minMemberDays} min={0} max={365} disabled={disabled}
          hint="Counted to when the proposal is made: joining later never gives a vote on it."
          onChange={(v) => set("minMemberDays", v)} />
        <Field label="Decided by" size="sm" hint={METHOD_HELP[rules.method]} className="sm:col-span-2">
          <Select aria-label="Decision method" value={rules.method} disabled={disabled}
            onChange={(e) => set("method", e.target.value as Method)}>
            {Object.values(DecisionMethod).map((method) => (
              <option key={method} value={method}>{METHOD_LABELS[method]}</option>
            ))}
          </Select>
        </Field>
        {rules.method !== DecisionMethod.Lazy && (
          <NumberField label="Quorum (% of voters)" value={rules.quorumPct} min={0} max={100} disabled={disabled}
            hint="Ballots of any choice count toward it. Without it the proposal expires."
            onChange={(v) => set("quorumPct", v)} />
        )}
        {rules.method === DecisionMethod.Majority && (
          <NumberField label="Yes must exceed (% of yes + no)" value={rules.thresholdPct} min={50} max={99} disabled={disabled}
            onChange={(v) => set("thresholdPct", v)} />
        )}
        {rules.method === DecisionMethod.Lazy && (
          <NumberField label="Objections that reject" value={rules.lazyObjections} min={1} max={50} disabled={disabled}
            onChange={(v) => set("lazyObjections", v)} />
        )}
        {afterMethod}
        <NumberField label="Discussion (hours)" value={rules.discussionHours} min={0} max={336} disabled={disabled}
          hint={`${describeHours(rules.discussionHours)} before voting opens.`}
          onChange={(v) => set("discussionHours", v)} />
        <NumberField label="Voting (hours)" value={rules.votingHours} min={1} max={720} disabled={disabled}
          hint={`Voting runs ${describeHours(rules.votingHours)}.`}
          onChange={(v) => set("votingHours", v)} />
      </div>

      <label className="flex items-start gap-3 text-sm">
        <input type="checkbox" className="mt-1" checked={rules.hideResults} disabled={disabled}
          onChange={(e) => set("hideResults", e.target.checked)} />
        <span>Hide ballots until voting closes<span className="block text-zinc-500">Only turnout shows while voting runs, so nobody votes with the crowd.</span></span>
      </label>
      {recuse && (
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" className="mt-1" checked={rules.recuseBeneficiaries} disabled={disabled}
            onChange={(e) => set("recuseBeneficiaries", e.target.checked)} />
          <span>{recuse.label}<span className="block text-zinc-500">{recuse.help}</span></span>
        </label>
      )}
    </div>
  );
}

/** The rules summary, what differs from the community default, and a collapsed editor. */
export function AdjustableProposalRules({
  kind, rules, baseline, onChange, children,
}: {
  kind: ProposalKind;
  rules: ProposalRules;
  baseline: ProposalRules;
  onChange: (rules: ProposalRules) => void;
  children: ReactNode;
}) {
  const changes = describeRulesChanges(rules, baseline);
  return (
    <>
      <div className="space-y-3 rounded-xl bg-zinc-800/60 p-3">
        {children}
        {changes.length > 0 && (
          <div className="space-y-2 border-t border-zinc-700/80 pt-3">
            <ul className="space-y-1 text-sm text-zinc-300">
              {changes.map((line) => <li key={line}>{line}</li>)}
            </ul>
            <Button variant="ghost" type="button" onClick={() => onChange(baseline)}>Reset</Button>
          </div>
        )}
      </div>
      <details className="text-sm">
        <summary className="cursor-pointer text-zinc-300">Adjust these rules</summary>
        <p className="mt-2 text-xs text-zinc-500">
          These apply only to this proposal. Once it is made they stay fixed, including through discussion and voting.
        </p>
        <div className="mt-3">
          <ProposalRulesEditor kind={kind} rules={rules} onChange={onChange} />
        </div>
      </details>
    </>
  );
}
