"use client";

// One proposal kind's settings. Admins edit; members read what applies.
// Saved settings apply to proposals made afterwards: open ones keep theirs.
import Link from "next/link";
import { useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { GovernanceDiscordResponse, OkResponse } from "@/lib/api/types";
import {
  DecisionMethod, ProposalKind, Proposers, type DecisionMethod as Method,
} from "@/lib/constants";
import { KIND_LABELS, METHOD_LABELS, PROPOSER_LABELS } from "@/lib/governance/labels";
import { rulesFor, type GovernanceSettings } from "@/lib/governance/rules";
import { ADA_ASSET, formatQuantity, scaleDecimal } from "@/lib/assets";
import { routes } from "@/lib/routes";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { Button, Card, ErrorText, Field, Input, NoticeText, Select, SectionTitle } from "@/components/ui";
import { ProposalRulesEditor } from "./ProposalRulesEditor";

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
    help: "Members can propose tasks on app boards only — not on GitHub boards, which keep using issues. A passed proposal adds the task to the board's first column; its leads make it payable as usual.",
  },
  [ProposalKind.Decision]: {
    label: "Polls",
    help: "Members can put a decision to a vote from the Proposals page. Nothing is applied automatically.",
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

export function GovernanceKindCard({ communityId, kind, initial, canEdit, onSaved, slug }: {
  communityId: string;
  kind: ProposalKind;
  initial: GovernanceSettings;
  canEdit: boolean;
  onSaved: () => void;
  /** Community slug for Integrations / Governance deep links after enabling a kind. */
  slug?: string;
}) {
  const [s, setS] = useState(initial);
  const [saved, setSaved] = useState(false);
  const [nextStep, setNextStep] = useState<string | null>(null);
  const save = useAsyncAction("Failed to save the settings");
  const set = <K extends keyof GovernanceSettings>(key: K, value: GovernanceSettings[K]) => {
    setSaved(false);
    setNextStep(null);
    setS((current) => ({ ...current, [key]: value }));
  };
  const text = ENABLE_TEXT[kind];
  const off = !canEdit;

  async function submit() {
    // The escalation select shows majority until one is chosen: save what it shows.
    const settings = s.lazyCapLovelace && !s.escalateMethod ? { ...s, escalateMethod: DecisionMethod.Majority } : s;
    const turningOn = settings.enabled && !initial.enabled;
    const ok = await save.run(() => apiFetch<OkResponse>("/api/governance/settings", { body: { communityId, kind, settings } }));
    if (ok) {
      setSaved(true);
      onSaved();
      if (turningOn && slug) {
        try {
          const discord = await apiFetch<GovernanceDiscordResponse>("/api/governance/discord", {
            query: { communityId },
          });
          if (!discord.discord.channelId) setNextStep("discord");
        } catch {
          // Save already succeeded; skip the optional next-step hint.
        }
      }
    }
  }

  return (
    <Card className="space-y-4">
      <SectionTitle>{KIND_LABELS[kind]} proposals</SectionTitle>
      <label className="flex items-start gap-3 text-sm">
        <input type="checkbox" className="mt-1" checked={s.enabled} disabled={off} onChange={(e) => set("enabled", e.target.checked)} />
        <span><strong>{text?.label ?? "On"}</strong><span className="block text-zinc-500">{text?.help}</span></span>
      </label>

      <ProposalRulesEditor kind={kind} rules={rulesFor(s)} disabled={off}
        onChange={(rules) => { setSaved(false); setS((current) => ({ ...current, ...rules })); }}
        leading={(
          <Field label="Who can propose" size="sm">
            <Select aria-label="Who can propose" value={s.proposers} disabled={off}
              onChange={(e) => set("proposers", e.target.value as Proposers)}>
              {Object.values(Proposers).map((p) => <option key={p} value={p}>{PROPOSER_LABELS[p]}</option>)}
            </Select>
          </Field>
        )}
        afterMethod={s.method === DecisionMethod.Lazy && kind === ProposalKind.Task ? (
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
        ) : undefined} />

      {canEdit && (
        <div className="flex flex-wrap items-center justify-end gap-3">
          <ErrorText error={save.error} />
          <NoticeText>{saved ? "Saved. New proposals use these settings." : null}</NoticeText>
          <Button loading={save.busy} onClick={() => void submit()}>Save</Button>
        </div>
      )}
      {nextStep === "discord" && slug && (
        <p className="text-sm text-amber-200">
          Want Discord announcements for these proposals?{" "}
          <Link className="underline" href={`${routes.integrations(slug)}#announcements`}>
            Pick a channel under Integrations
          </Link>
          {" "}(and optionally publish signed tallies under Records on this page).
        </p>
      )}
    </Card>
  );
}
