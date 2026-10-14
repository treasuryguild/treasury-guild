"use client";

// The template part of the new-treasury form: which fixed script shape,
// its lock date, the recovery group and the co-signer. The base signers and
// their threshold stay on the page; this component owns everything the
// template adds, in one draft object the page sends as it is.
import { templateLabel } from "@/lib/cardano/spendingPaths";
import type { ScriptType } from "@/lib/cardano/types";
import { CosignerKind, TREASURY_TEMPLATES, TreasuryTemplate } from "@/lib/constants";
import type { MemberWithContributor } from "@/lib/db/types";
import { shortAddress } from "@/lib/format";
import { Button, Field, Input, Select } from "@/components/ui";

export interface SignerDraft {
  address: string;
  name: string;
}

export interface TemplateDraft {
  template: TreasuryTemplate;
  /** Local date-time string of the `datetime-local` input. */
  lockUntil: string;
  recoveryScriptType: ScriptType;
  recoveryRequired: number;
  recoverySigners: SignerDraft[];
  cosignerKind: CosignerKind;
  cosignerAddress: string;
}

export const emptySigner = (): SignerDraft => ({ address: "", name: "" });

export const emptyTemplateDraft = (): TemplateDraft => ({
  template: TreasuryTemplate.Plain,
  lockUntil: "",
  recoveryScriptType: "any",
  recoveryRequired: 1,
  recoverySigners: [emptySigner()],
  cosignerKind: CosignerKind.Member,
  cosignerAddress: "",
});

export const TEMPLATE_HINTS: Record<TreasuryTemplate, string> = {
  [TreasuryTemplate.Plain]: "The base signers spend under the rule below. Nothing else.",
  [TreasuryTemplate.Clawback]: "The base signers can always spend. From the lock date, the recovery signers can move the funds out too (payments only).",
  [TreasuryTemplate.LockUntil]: "Nobody can spend before the lock date; the treasury still receives. From the date, the base signers spend as usual.",
  [TreasuryTemplate.Cosigner]: "Every normal spend needs the base rule plus one co-signer that signs only what passes the app's check (outputs match the stored rows, the spend fits the voted budgets, every cited decision passed). Every base signer together can spend without the co-signer.",
};

/** What the template draft sends with the create request; the base signers are the page's. */
export function templateRequest(draft: TemplateDraft) {
  const lockUntil = draft.lockUntil ? new Date(draft.lockUntil).toISOString() : undefined;
  switch (draft.template) {
    case TreasuryTemplate.Clawback:
      return {
        template: draft.template,
        lockUntil,
        recovery: {
          scriptType: draft.recoveryScriptType,
          required: draft.recoveryRequired,
          signers: draft.recoverySigners.filter((s) => s.address.trim()).map((s) => ({ address: s.address.trim(), name: s.name.trim() })),
        },
      };
    case TreasuryTemplate.LockUntil:
      return { template: draft.template, lockUntil };
    case TreasuryTemplate.Cosigner:
      return {
        template: draft.template,
        cosigner: draft.cosignerKind === CosignerKind.App
          ? { kind: CosignerKind.App }
          : { kind: CosignerKind.Member, address: draft.cosignerAddress },
      };
    default:
      return { template: draft.template };
  }
}

/** Whether the draft has everything its template needs. */
export function templateComplete(draft: TemplateDraft): boolean {
  switch (draft.template) {
    case TreasuryTemplate.Clawback:
      return !!draft.lockUntil && draft.recoverySigners.some((s) => s.address.trim());
    case TreasuryTemplate.LockUntil:
      return !!draft.lockUntil;
    case TreasuryTemplate.Cosigner:
      return draft.cosignerKind === CosignerKind.App || !!draft.cosignerAddress;
    default:
      return true;
  }
}

export function TemplateFields({
  draft,
  onChange,
  members,
  disabled,
}: {
  draft: TemplateDraft;
  onChange: (patch: Partial<TemplateDraft>) => void;
  /** The community's members, for the co-signer pick. */
  members: MemberWithContributor[];
  disabled: boolean;
}) {
  const recoveryFilled = draft.recoverySigners.filter((s) => s.address.trim()).length;
  function updateRecovery(i: number, patch: Partial<SignerDraft>) {
    onChange({ recoverySigners: draft.recoverySigners.map((p, j) => (j === i ? { ...p, ...patch } : p)) });
  }
  return (
    <>
      <Field label="Template" hint={TEMPLATE_HINTS[draft.template]}>
        <Select aria-label="Template" value={draft.template} disabled={disabled}
          onChange={(e) => onChange({ template: e.target.value as TreasuryTemplate })}>
          {TREASURY_TEMPLATES.map((t) => <option key={t} value={t}>{templateLabel(t)}</option>)}
        </Select>
      </Field>

      {(draft.template === TreasuryTemplate.Clawback || draft.template === TreasuryTemplate.LockUntil) && (
        <Field label="Lock date" hint="At least one hour from now. It is written into the script and can never change.">
          <Input aria-label="Lock date" type="datetime-local" value={draft.lockUntil} disabled={disabled}
            onChange={(e) => onChange({ lockUntil: e.target.value })} />
        </Field>
      )}

      {draft.template === TreasuryTemplate.Clawback && (
        <>
          <Field label="Recovery signers (payment addresses)" hint="Must already be community members. They are not made admins.">
            <div className="space-y-2">
              {draft.recoverySigners.map((s, i) => (
                <div key={i} className="flex flex-col gap-2 sm:flex-row">
                  <Input aria-label={`Recovery signer ${i + 1} address`} className="font-mono text-xs" value={s.address} disabled={disabled}
                    onChange={(e) => updateRecovery(i, { address: e.target.value })} placeholder="addr… / addr_test…" />
                  <Input aria-label={`Recovery signer ${i + 1} name`} className="sm:max-w-32" value={s.name} disabled={disabled}
                    onChange={(e) => updateRecovery(i, { name: e.target.value })} placeholder="Name" />
                </div>
              ))}
            </div>
            <Button variant="ghost" className="mt-2" disabled={disabled}
              onClick={() => onChange({ recoverySigners: [...draft.recoverySigners, emptySigner()] })}>
              + Add recovery signer
            </Button>
          </Field>
          <Field label="Recovery rule">
            <div className="flex flex-col gap-2 sm:flex-row">
              <Select aria-label="Recovery rule" value={draft.recoveryScriptType} disabled={disabled}
                onChange={(e) => onChange({ recoveryScriptType: e.target.value as ScriptType })}>
                <option value="any">Any recovery signer</option>
                <option value="all">All recovery signers</option>
                <option value="atLeast">At least N recovery signers</option>
              </Select>
              {draft.recoveryScriptType === "atLeast" && (
                <Input aria-label="Recovery required signatures" type="number" min={1} max={Math.max(recoveryFilled, 1)} className="sm:max-w-24"
                  value={draft.recoveryRequired} disabled={disabled}
                  onChange={(e) => onChange({ recoveryRequired: Number(e.target.value) })} />
              )}
            </div>
          </Field>
        </>
      )}

      {draft.template === TreasuryTemplate.Cosigner && (
        <Field label="Co-signer" hint="A member who reads the check before signing, or a key Guild Vault generates and keeps encrypted, signing only what passes.">
          <div className="flex flex-col gap-2 sm:flex-row">
            <Select aria-label="Co-signer kind" value={draft.cosignerKind} disabled={disabled}
              onChange={(e) => onChange({ cosignerKind: e.target.value as CosignerKind })}>
              <option value={CosignerKind.Member}>A member</option>
              <option value={CosignerKind.App}>Guild Vault (app-held key)</option>
            </Select>
            {draft.cosignerKind === CosignerKind.Member && (
              <Select aria-label="Co-signer wallet" value={draft.cosignerAddress} disabled={disabled}
                onChange={(e) => onChange({ cosignerAddress: e.target.value })}>
                <option value="">Choose a member…</option>
                {members.map((m) => (
                  <option key={m.wallet_address} value={m.wallet_address}>
                    {m.contributors?.handle ? `${m.contributors.handle} (${shortAddress(m.wallet_address)})` : shortAddress(m.wallet_address)}
                  </option>
                ))}
              </Select>
            )}
          </div>
        </Field>
      )}
    </>
  );
}

/** The confirmation's plain-words summary of what the template does and when. */
export function templateSummary(draft: TemplateDraft, baseRule: string): string[] {
  const date = draft.lockUntil ? new Date(draft.lockUntil).toLocaleString() : "the lock date";
  switch (draft.template) {
    case TreasuryTemplate.Clawback:
      return [
        `The base signers (${baseRule}) can spend at any time.`,
        `From ${date}, the recovery signers can also move the funds out, to any address, with payments only.`,
        "Recovery signers are not made admins; they must already be members.",
        "The date and both groups are written into the script and can never be changed. A mistake means creating a new treasury.",
      ];
    case TreasuryTemplate.LockUntil:
      return [
        `Nobody can spend from this treasury before ${date}. It can still receive.`,
        `From ${date}, the base signers (${baseRule}) spend as usual.`,
        "The date is written into the script and can never be changed. A mistake means creating a new treasury.",
      ];
    case TreasuryTemplate.Cosigner:
      return [
        `A normal spend needs the base rule (${baseRule}) plus the co-signer, who signs only what passes the check.`,
        "Every base signer together can spend without the co-signer.",
        draft.cosignerKind === CosignerKind.App
          ? "Guild Vault generates the co-signer key now and keeps it encrypted. It can never be rotated; if it is lost, only every base signer together can move the funds."
          : "The co-signer is a member's wallet. They are not made an admin.",
        "The groups are written into the script and can never be changed.",
      ];
    default:
      return [`The base signers (${baseRule}) spend. Signers and the threshold cannot be edited afterwards.`];
  }
}
