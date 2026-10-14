"use client";

import { useMemo, useState } from "react";
import type { BuildMintBody } from "@/lib/api/schemas";
import type { MintWithTx, TreasurySummary } from "@/lib/db/types";
import { buildMintRequest } from "@/lib/mint/buildMintRequest";
import { lockedPoliciesFor } from "@/lib/mint/lockedPolicies";
import {
  emptyMintForm,
  NEW_LOCK,
  type MintFormState,
  type MintKind,
} from "@/lib/mint/types";
import { validateMintForm } from "@/lib/mint/validateMintForm";
import { Button, Card, ErrorText, Field, Select, WarningText } from "@/components/ui";
import { FungibleTokenForm } from "./FungibleTokenForm";
import { NftRepeater } from "./NftRepeater";
import { PolicySection } from "./PolicySection";
import { actsForTreasury } from "@/lib/roles";
import { TxKind, type SpendingPath } from "@/lib/constants";
import { offeredPaths, PathPicker } from "@/components/tx/PathPicker";

const KINDS: { value: MintKind; label: string }[] = [
  { value: "ft", label: "Fungible token" },
  { value: "nft", label: "NFT" },
];

export function MintForm({
  communityId,
  treasuries,
  signerTreasuryIds,
  isAdmin,
  mints,
  gateway,
  busy,
  error,
  blockedReason = null,
  onBuild,
}: {
  communityId: string;
  treasuries: TreasurySummary[];
  signerTreasuryIds: Set<string>;
  isAdmin: boolean;
  mints: MintWithTx[];
  gateway: string | null;
  busy: boolean;
  error: string | null;
  /** Why building is unavailable (wallet on the other network); disables the button. */
  blockedReason?: string | null;
  onBuild: (body: BuildMintBody) => void;
}) {
  const [form, setForm] = useState<MintFormState>(() => ({
    ...emptyMintForm(),
    treasuryId: treasuries.length === 1 ? (treasuries[0]?.id ?? "") : "",
  }));
  const [validationError, setValidationError] = useState<string | null>(null);
  // Fixed at mount so the locked-policy filter is stable across renders.
  const [nowMs] = useState(() => Date.now());

  const patch = (next: Partial<MintFormState>) =>
    setForm((prev) => ({ ...prev, ...next }));

  const selectedTreasury = treasuries.find((t) => t.id === form.treasuryId) ?? null;
  const canMintHere =
    !!selectedTreasury && actsForTreasury({ isAdmin, signerTreasuryIds }, selectedTreasury.id);
  // A lock-until treasury mints nothing before its date; a co-signer
  // treasury offers the co-signed path (default) or the bypass.
  const [path, setPath] = useState<SpendingPath | "">("");
  const offered = selectedTreasury ? offeredPaths(selectedTreasury, TxKind.Mint, nowMs) : { paths: [], blocked: null };
  const chosenPath = path && offered.paths.includes(path) ? path : offered.paths[0];
  const lockedPolicies = useMemo(
    () => lockedPoliciesFor(mints, form.treasuryId, nowMs),
    [mints, form.treasuryId, nowMs],
  );

  function submit() {
    const problem = validateMintForm(form, { canMintHere, now: Date.now() });
    setValidationError(problem);
    if (problem) return;
    onBuild({ ...buildMintRequest(form), path: chosenPath });
  }

  return (
    <Card className="space-y-5">
      <div className="grid gap-4 sm:grid-cols-2">
        <Field label="Minting treasury (policy)">
          <Select
            value={form.treasuryId}
            onChange={(e) => patch({ treasuryId: e.target.value, existingLock: NEW_LOCK })}
          >
            <option value="">Choose…</option>
            {treasuries.map((t) => (
              <option key={t.id} value={t.id}>
                {t.name}
                {signerTreasuryIds.has(t.id) ? " (you sign)" : ""}
              </option>
            ))}
          </Select>
        </Field>
        <Field label="Token type">
          <div className="flex rounded-lg border border-zinc-700 p-0.5">
            {KINDS.map((k) => (
              <button
                key={k.value}
                type="button"
                onClick={() => patch({ kind: k.value })}
                className={`flex-1 rounded-md px-3 py-1.5 text-sm transition-colors ${
                  form.kind === k.value
                    ? "bg-indigo-600 text-white"
                    : "text-zinc-300 hover:bg-zinc-800"
                }`}
              >
                {k.label}
              </button>
            ))}
          </div>
        </Field>
      </div>

      {form.kind === "ft" ? (
        <FungibleTokenForm
          form={form}
          patch={patch}
          communityId={communityId}
          gateway={gateway}
        />
      ) : (
        <NftRepeater
          nfts={form.nfts}
          onChange={(nfts) => patch({ nfts })}
          communityId={communityId}
          gateway={gateway}
        />
      )}

      <PolicySection
        form={form}
        patch={patch}
        lockedPolicies={lockedPolicies}
        selectedTreasury={selectedTreasury}
      />

      <PathPicker treasury={selectedTreasury} kind={TxKind.Mint} value={chosenPath ?? ""} onChange={setPath} disabled={busy} nowMs={nowMs} />

      <ErrorText error={validationError ?? error} />
      <WarningText small>{blockedReason}</WarningText>
      <Button
        onClick={submit}
        disabled={!form.treasuryId || !!blockedReason || !chosenPath}
        loading={busy}
      >
        {busy ? "Building transaction…" : "Build mint transaction"}
      </Button>
      <p className="text-xs text-zinc-500">
        The transaction is built from the treasury and needs the treasury&apos;s
        signature threshold before it can be submitted. Metadata follows
        CIP-25 (label 721); images are pinned on IPFS.
      </p>
    </Card>
  );
}
