"use client";

import type { TreasurySummary } from "@/lib/db/types";
import { formatDate, shortAddress } from "@/lib/format";
import {
  NEW_LOCK,
  type LockedPolicy,
  type MintFormState,
  type PolicyMode,
} from "@/lib/mint/types";
import { Field, Input, Select } from "@/components/ui";

export function PolicySection({
  form,
  patch,
  lockedPolicies,
  selectedTreasury,
}: {
  form: MintFormState;
  patch: (next: Partial<MintFormState>) => void;
  lockedPolicies: LockedPolicy[];
  selectedTreasury: TreasurySummary | null;
}) {
  return (
    <>
      <div className="grid gap-4 sm:grid-cols-2">
        <Field
          label="Policy"
          hint={
            form.policyMode === "treasury"
              ? "Policy ID = the treasury script hash. Signers can mint more later."
              : "Policy = treasury script AND before-slot lock. Nothing can be minted under it after the date."
          }
        >
          <Select
            value={form.policyMode}
            onChange={(e) => patch({ policyMode: e.target.value as PolicyMode })}
          >
            <option value="treasury">Open — treasury multisig script</option>
            <option value="locked">Time-locked — fixed supply after a date</option>
          </Select>
        </Field>
        {form.policyMode === "locked" && (
          <Field label="Locks at">
            {lockedPolicies.length > 0 && (
              <Select
                className="mb-2"
                value={form.existingLock}
                onChange={(e) => patch({ existingLock: e.target.value })}
              >
                <option value={NEW_LOCK}>New locked policy…</option>
                {lockedPolicies.map((p) => (
                  <option key={p.policyId} value={String(p.lockSlot)}>
                    {shortAddress(p.policyId)} · locks{" "}
                    {p.lockUntil ? formatDate(p.lockUntil) : `slot ${p.lockSlot}`}
                  </option>
                ))}
              </Select>
            )}
            {form.existingLock === NEW_LOCK && (
              <Input
                type="datetime-local"
                value={form.lockUntil}
                onChange={(e) => patch({ lockUntil: e.target.value })}
              />
            )}
          </Field>
        )}
      </div>

      <Field label="Send minted tokens to">
        <Input
          className="font-mono text-xs"
          value={form.recipient}
          onChange={(e) => patch({ recipient: e.target.value })}
          placeholder={
            selectedTreasury
              ? `${selectedTreasury.address} (treasury, default)`
              : "addr… (defaults to the treasury)"
          }
        />
      </Field>
    </>
  );
}
