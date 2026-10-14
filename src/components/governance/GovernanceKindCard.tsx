"use client";

// One proposal kind's settings. Admins edit; members read what applies.
// Saved settings apply to proposals made afterwards: open ones keep theirs.
import { useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { OkResponse } from "@/lib/api/types";
import {
  DecisionMethod, Electorate, ProposalKind, Proposers, type DecisionMethod as Method,
} from "@/lib/constants";
import {
  describeHours, ELECTORATE_LABELS, KIND_LABELS, METHOD_HELP, METHOD_LABELS, PROPOSER_LABELS,
} from "@/lib/governance/labels";
import type { GovernanceSettings } from "@/lib/governance/rules";
import { ADA_ASSET, formatQuantity, scaleDecimal } from "@/lib/assets";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { Button, Card, ErrorText, Field, Input, NoticeText, Select, SectionTitle } from "@/components/ui";

const ENABLE_TEXT: Partial<Record<ProposalKind, { label: string; help: string }>> = {
  [ProposalKind.Budget]: {
    label: "Budget consent",
    help: "Budget changes on the Budgets page become proposals and apply only when they pass. Direct saves and budget resets are refused.",
  },
  [ProposalKind.Workgroup]: {
    label: "New workgroups by vote",
    help: "A new workgroup is created when its proposal passes, as an app board with the proposed leads. Admins can no longer add workgroups directly.",
  },
  [ProposalKind.Task]: {
    label: "Task proposals",
    help: "Members can propose tasks on app boards. A passed proposal adds the task to the board's first column; its leads make it payable as usual.",
  },
  [ProposalKind.Decision]: {
    label: "Polls",
    help: "Members can put a decision to a vote from the Proposals page. Nothing is applied automatically.",
  },
};

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

/** The lazy-consensus cap in ADA, stored in lovelace; empty means no cap. */
function LazyCapField({ value, disabled, onChange }: {
  value: string | null; disabled: boolean; onChange: (lovelace: string | null) => void;
}) {
  const [text, setText] = useState(value === null ? "" : formatQuantity(BigInt(value), ADA_ASSET.decimals));
  const [error, setError] = useState<string | null>(null);
  return (
    <Field label="Lazy consensus up to (ADA)" size="sm"
      hint={error ?? "A task above this, or paid in any other token, is decided by the method below instead. Empty: no cap."}>
      <Input aria-label="Lazy consensus cap in ADA" inputMode="decimal" value={text} disabled={disabled}
        onChange={(e) => {
          const next = e.target.value;
          setText(next);
          if (!next.trim()) { setError(null); onChange(null); return; }
          try {
            const lovelace = scaleDecimal(next.trim(), ADA_ASSET.decimals);
            if (lovelace <= 0n) throw new Error("above zero");
            setError(null);
            onChange(lovelace.toString());
          } catch {
            setError("Enter an ADA amount above zero, with at most 6 decimals");
          }
        }} />
    </Field>
  );
}

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

export function GovernanceKindCard({ communityId, kind, initial, canEdit, onSaved }: {
  communityId: string;
  kind: ProposalKind;
  initial: GovernanceSettings;
  canEdit: boolean;
  onSaved: () => void;
}) {
  const [s, setS] = useState(initial);
  const [saved, setSaved] = useState(false);
  const save = useAsyncAction("Failed to save the settings");
  const set = <K extends keyof GovernanceSettings>(key: K, value: GovernanceSettings[K]) => {
    setSaved(false);
    setS((current) => ({ ...current, [key]: value }));
  };
  const text = ENABLE_TEXT[kind];
  const recuse = RECUSE_TEXT[kind];
  const off = !canEdit;
  const windowed = s.electorate === Electorate.Workgroup || s.electorate === Electorate.Contributors;

  async function submit() {
    // The escalation select shows majority until one is chosen: save what it shows.
    const settings = s.lazyCapLovelace && !s.escalateMethod ? { ...s, escalateMethod: DecisionMethod.Majority } : s;
    const ok = await save.run(() => apiFetch<OkResponse>("/api/governance/settings", { body: { communityId, kind, settings } }));
    if (ok) {
      setSaved(true);
      onSaved();
    }
  }

  return (
    <Card className="space-y-4">
      <SectionTitle>{KIND_LABELS[kind]} proposals</SectionTitle>
      <label className="flex items-start gap-3 text-sm">
        <input type="checkbox" className="mt-1" checked={s.enabled} disabled={off} onChange={(e) => set("enabled", e.target.checked)} />
        <span><strong>{text?.label ?? "On"}</strong><span className="block text-zinc-500">{text?.help}</span></span>
      </label>

      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Who can propose" size="sm">
          <Select aria-label="Who can propose" value={s.proposers} disabled={off}
            onChange={(e) => set("proposers", e.target.value as Proposers)}>
            {Object.values(Proposers).map((p) => <option key={p} value={p}>{PROPOSER_LABELS[p]}</option>)}
          </Select>
        </Field>
        <Field label="Who votes" size="sm" hint={s.electorate === Electorate.Workgroup
          ? "Leads, recently paid contributors and assignees of the workgroups a proposal concerns; recently paid contributors when it concerns none."
          : undefined}>
          <Select aria-label="Who votes" value={s.electorate} disabled={off}
            onChange={(e) => set("electorate", e.target.value as Electorate)}>
            {Object.values(Electorate).map((e) => <option key={e} value={e}>{ELECTORATE_LABELS[e]}</option>)}
          </Select>
        </Field>
        {windowed && (
          <NumberField label="Look back (months)" value={s.activityMonths} min={1} max={36} disabled={off}
            onChange={(v) => set("activityMonths", v)} />
        )}
        <NumberField label="Minimum membership (days)" value={s.minMemberDays} min={0} max={365} disabled={off}
          hint="Counted to when the proposal is made: joining later never gives a vote on it."
          onChange={(v) => set("minMemberDays", v)} />
        <Field label="Decided by" size="sm" hint={METHOD_HELP[s.method]} className="sm:col-span-2">
          <Select aria-label="Decision method" value={s.method} disabled={off}
            onChange={(e) => set("method", e.target.value as Method)}>
            {Object.values(DecisionMethod).map((m) => <option key={m} value={m}>{METHOD_LABELS[m]}</option>)}
          </Select>
        </Field>
        {s.method !== DecisionMethod.Lazy && (
          <NumberField label="Quorum (% of voters)" value={s.quorumPct} min={0} max={100} disabled={off}
            hint="Ballots of any choice count toward it. Without it the proposal expires." onChange={(v) => set("quorumPct", v)} />
        )}
        {s.method === DecisionMethod.Majority && (
          <NumberField label="Yes must exceed (% of yes + no)" value={s.thresholdPct} min={50} max={99} disabled={off}
            onChange={(v) => set("thresholdPct", v)} />
        )}
        {s.method === DecisionMethod.Lazy && (
          <NumberField label="Objections that reject" value={s.lazyObjections} min={1} max={50} disabled={off}
            onChange={(v) => set("lazyObjections", v)} />
        )}
        {s.method === DecisionMethod.Lazy && kind === ProposalKind.Task && (
          <>
            <LazyCapField value={s.lazyCapLovelace} disabled={off} onChange={(v) => set("lazyCapLovelace", v)} />
            <Field label="Above the cap, decided by" size="sm">
              <Select aria-label="Method above the cap" value={s.escalateMethod ?? DecisionMethod.Majority} disabled={off}
                onChange={(e) => set("escalateMethod", e.target.value as Method)}>
                <option value={DecisionMethod.Majority}>{METHOD_LABELS.majority}</option>
                <option value={DecisionMethod.Consent}>{METHOD_LABELS.consent}</option>
              </Select>
            </Field>
          </>
        )}
        <NumberField label="Discussion (hours)" value={s.discussionHours} min={0} max={336} disabled={off}
          hint={`${describeHours(s.discussionHours)} before voting opens.`} onChange={(v) => set("discussionHours", v)} />
        <NumberField label="Voting (hours)" value={s.votingHours} min={1} max={720} disabled={off}
          hint={`Voting runs ${describeHours(s.votingHours)}.`} onChange={(v) => set("votingHours", v)} />
      </div>

      <label className="flex items-start gap-3 text-sm">
        <input type="checkbox" className="mt-1" checked={s.hideResults} disabled={off} onChange={(e) => set("hideResults", e.target.checked)} />
        <span>Hide ballots until voting closes<span className="block text-zinc-500">Only turnout shows while voting runs, so nobody votes with the crowd.</span></span>
      </label>
      {recuse && (
        <label className="flex items-start gap-3 text-sm">
          <input type="checkbox" className="mt-1" checked={s.recuseBeneficiaries} disabled={off}
            onChange={(e) => set("recuseBeneficiaries", e.target.checked)} />
          <span>{recuse.label}<span className="block text-zinc-500">{recuse.help}</span></span>
        </label>
      )}

      {canEdit && (
        <div className="flex flex-wrap items-center justify-end gap-3">
          <ErrorText error={save.error} />
          <NoticeText>{saved ? "Saved. New proposals use these settings." : null}</NoticeText>
          <Button loading={save.busy} onClick={() => void submit()}>Save</Button>
        </div>
      )}
    </Card>
  );
}
