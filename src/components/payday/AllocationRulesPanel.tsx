"use client";

import { useState } from "react";
import { apiFetch } from "@/lib/api/client";
import type { AllocationRuleCreatedResponse, AllocationRuleResponse, OkResponse } from "@/lib/api/types";
import { MAX_PAYDAY_ALLOCATION_RULES } from "@/lib/constants";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { Button, Card, ErrorText, Field, Input, Select } from "@/components/ui";

type DestKind = "external" | "sibling";

interface Draft {
  label: string;
  percent: string;
  enabled: boolean;
  unitScope: "all" | "selected";
  unitsText: string;
  destKind: DestKind;
  recipientWallet: string;
  recipientTreasuryId: string;
}

const emptyDraft = (): Draft => ({
  label: "",
  percent: "1",
  enabled: true,
  unitScope: "all",
  unitsText: "",
  destKind: "external",
  recipientWallet: "",
  recipientTreasuryId: "",
});

function percentToBp(percent: string): number | null {
  const n = Number(percent);
  if (!Number.isFinite(n) || n <= 0 || n > 100) return null;
  const bp = Math.round(n * 100);
  if (bp < 1 || bp > 10000) return null;
  return bp;
}

function bpToPercent(bp: number): string {
  return (bp / 100).toString();
}

function parseUnits(text: string): string[] {
  return [...new Set(text.split(/[\s,]+/).map((u) => u.trim()).filter(Boolean))];
}

/** Admin panel: configure Payday % allocations for the selected paying treasury. */
export function AllocationRulesPanel({
  treasuryId,
  siblings,
  rules,
  onChanged,
}: {
  treasuryId: string;
  siblings: readonly { id: string; name: string; archived_at: string | null }[];
  rules: AllocationRuleResponse[];
  onChanged: () => void;
}) {
  const [draft, setDraft] = useState<Draft>(emptyDraft);
  const [editingId, setEditingId] = useState<string | null>(null);
  const save = useAsyncAction("Could not save allocation rule");
  const remove = useAsyncAction("Could not delete allocation rule");
  const activeSiblings = siblings.filter((s) => !s.archived_at);

  function startEdit(rule: AllocationRuleResponse) {
    setEditingId(rule.id);
    setDraft({
      label: rule.label,
      percent: bpToPercent(rule.basis_points),
      enabled: rule.enabled,
      unitScope: rule.unit_scope,
      unitsText: rule.units.join(", "),
      destKind: rule.recipient_treasury_id ? "sibling" : "external",
      recipientWallet: rule.recipient_wallet ?? "",
      recipientTreasuryId: rule.recipient_treasury_id ?? "",
    });
  }

  function cancelEdit() {
    setEditingId(null);
    setDraft(emptyDraft());
  }

  async function submit() {
    const bp = percentToBp(draft.percent);
    if (bp === null) {
      save.setError("Enter a percent between 0.01 and 100");
      return;
    }
    const units = draft.unitScope === "selected" ? parseUnits(draft.unitsText) : [];
    const body = {
      label: draft.label.trim(),
      basisPoints: bp,
      enabled: draft.enabled,
      unitScope: draft.unitScope,
      units,
      recipientWallet: draft.destKind === "external" ? draft.recipientWallet.trim() || null : null,
      recipientTreasuryId: draft.destKind === "sibling" ? draft.recipientTreasuryId || null : null,
      sortOrder: editingId
        ? (rules.find((r) => r.id === editingId)?.sort_order ?? rules.length)
        : rules.length,
    };
    await save.run(async () => {
      if (editingId) {
        await apiFetch<OkResponse>(`/api/treasury/allocation-rules/${editingId}`, {
          method: "PATCH",
          body: JSON.stringify(body),
        });
      } else {
        await apiFetch<AllocationRuleCreatedResponse>("/api/treasury/allocation-rules", {
          method: "POST",
          body: JSON.stringify({ treasuryId, ...body }),
        });
      }
      cancelEdit();
      onChanged();
    });
  }

  async function onDelete(id: string) {
    if (!confirm("Delete this allocation rule?")) return;
    await remove.run(async () => {
      await apiFetch<OkResponse>(`/api/treasury/allocation-rules/${id}`, { method: "DELETE" });
      if (editingId === id) cancelEdit();
      onChanged();
    });
  }

  const atCap = !editingId && rules.length >= MAX_PAYDAY_ALLOCATION_RULES;

  return (
    <Card>
      <div className="space-y-3">
        <div>
          <h2 className="text-sm font-medium text-zinc-200">Allocation rules</h2>
          <p className="mt-1 text-sm text-zinc-400">
            Optional percent of each Payday&apos;s paid tokens, on top of full bounties:
            pay an outside wallet (treasury budget) or move to a sibling treasury (savings).
          </p>
        </div>

        {rules.length === 0 && !editingId && (
          <p className="text-sm text-zinc-500">No rules yet. Add one to skim a percent on every payout from this treasury.</p>
        )}

        <ul className="space-y-2">
          {rules.map((rule) => (
            <li
              key={rule.id}
              className="flex flex-wrap items-center justify-between gap-2 rounded border border-zinc-800 px-3 py-2 text-sm"
            >
              <div>
                <span className={rule.enabled ? "text-zinc-200" : "text-zinc-500 line-through"}>
                  {rule.label}
                </span>
                <span className="ml-2 text-zinc-400">
                  {bpToPercent(rule.basis_points)}%
                  {rule.unit_scope === "selected" ? ` · ${rule.units.length} token(s)` : " · all tokens"}
                  {rule.recipient_treasury_id
                    ? ` · sibling treasury`
                    : ` · ${rule.recipient_wallet?.slice(0, 12)}…`}
                </span>
              </div>
              <div className="flex gap-2">
                <Button type="button" variant="ghost" onClick={() => startEdit(rule)}>Edit</Button>
                <Button type="button" variant="ghost" onClick={() => onDelete(rule.id)} disabled={remove.busy}>
                  Delete
                </Button>
              </div>
            </li>
          ))}
        </ul>

        {(editingId || !atCap) && (
          <div className="space-y-3 border-t border-zinc-800 pt-3">
            <p className="text-sm font-medium text-zinc-300">
              {editingId ? "Edit rule" : "New rule"}
            </p>
            <div className="grid gap-3 sm:grid-cols-2">
              <Field label="Label">
                <Input
                  value={draft.label}
                  onChange={(e) => setDraft({ ...draft, label: e.target.value })}
                  placeholder="Ops fee"
                  maxLength={80}
                />
              </Field>
              <Field label="Percent">
                <Input
                  value={draft.percent}
                  onChange={(e) => setDraft({ ...draft, percent: e.target.value })}
                  placeholder="1"
                  inputMode="decimal"
                />
              </Field>
              <Field label="Destination">
                <Select
                  value={draft.destKind}
                  onChange={(e) => setDraft({ ...draft, destKind: e.target.value as DestKind })}
                >
                  <option value="external">Outside wallet</option>
                  <option value="sibling">Sibling treasury</option>
                </Select>
              </Field>
              {draft.destKind === "external" ? (
                <Field label="Address">
                  <Input
                    value={draft.recipientWallet}
                    onChange={(e) => setDraft({ ...draft, recipientWallet: e.target.value })}
                    placeholder="addr1… or addr_test1…"
                  />
                </Field>
              ) : (
                <Field label="Treasury">
                  <Select
                    value={draft.recipientTreasuryId}
                    onChange={(e) => setDraft({ ...draft, recipientTreasuryId: e.target.value })}
                  >
                    <option value="">Select…</option>
                    {activeSiblings.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </Select>
                </Field>
              )}
              <Field label="Tokens">
                <Select
                  value={draft.unitScope}
                  onChange={(e) => setDraft({ ...draft, unitScope: e.target.value as "all" | "selected" })}
                >
                  <option value="all">All tokens in the payout</option>
                  <option value="selected">Specific units</option>
                </Select>
              </Field>
              {draft.unitScope === "selected" && (
                <Field label="Units (comma-separated policy+asset hex, or lovelace)">
                  <Input
                    value={draft.unitsText}
                    onChange={(e) => setDraft({ ...draft, unitsText: e.target.value })}
                    placeholder="lovelace, …"
                  />
                </Field>
              )}
              <label className="flex items-center gap-2 text-sm text-zinc-300 sm:col-span-2">
                <input
                  type="checkbox"
                  checked={draft.enabled}
                  onChange={(e) => setDraft({ ...draft, enabled: e.target.checked })}
                />
                Enabled on Payday builds
              </label>
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" onClick={() => void submit()} disabled={save.busy || !draft.label.trim()}>
                {editingId ? "Save rule" : "Add rule"}
              </Button>
              {editingId && (
                <Button type="button" variant="ghost" onClick={cancelEdit}>Cancel</Button>
              )}
            </div>
            <ErrorText error={save.error ?? remove.error} />
          </div>
        )}

        {atCap && (
          <p className="text-sm text-zinc-500">
            At most {MAX_PAYDAY_ALLOCATION_RULES} rules per treasury. Delete one to add another.
          </p>
        )}
      </div>
    </Card>
  );
}
