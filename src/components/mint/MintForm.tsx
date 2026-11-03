"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import type { BuildMintBody } from "@/lib/api/schemas";
import type { MintWithTx, TreasurySummary } from "@/lib/db/types";
import { buildMintRequest } from "@/lib/mint/buildMintRequest";
import { lockedPoliciesFor } from "@/lib/mint/lockedPolicies";
import { mintFormFromRow, reuseBannerText, type MintReuseMode } from "@/lib/mint/reuseMint";
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

export const MINT_FORM_ANCHOR_ID = "mint-form";

const KINDS: { value: MintKind; label: string }[] = [
  { value: "ft", label: "Fungible token" },
  { value: "nft", label: "NFT" },
];

export function MintForm({
  communityId,
  treasuries,
  signerTreasuryIds,
  mints,
  gateway,
  busy,
  error,
  blockedReason = null,
  reuseSeed = null,
  onBuild,
}: {
  communityId: string;
  treasuries: TreasurySummary[];
  signerTreasuryIds: Set<string>;
  mints: MintWithTx[];
  gateway: string | null;
  busy: boolean;
  error: string | null;
  /** Why building is unavailable (wallet on the other network); disables the button. */
  blockedReason?: string | null;
  /**
   * Latest Minted assets reuse click. `nonce` changes on every click so the
   * same row can be applied twice; kept in the parent so Strict Mode remounts
   * still re-apply.
   */
  reuseSeed?: { row: MintWithTx; mode: MintReuseMode; nonce: number } | null;
  onBuild: (body: BuildMintBody) => void;
}) {
  const [form, setForm] = useState<MintFormState>(() => ({
    ...emptyMintForm(),
    treasuryId: treasuries.length === 1 ? (treasuries[0]?.id ?? "") : "",
  }));
  const [validationError, setValidationError] = useState<string | null>(null);
  // Fixed at mount so the locked-policy filter is stable across renders.
  const [nowMs] = useState(() => Date.now());
  const cardRef = useRef<HTMLDivElement>(null);
  const appliedNonce = useRef<number | null>(null);

  const patch = (next: Partial<MintFormState>) =>
    setForm((prev) => ({ ...prev, ...next }));

  const clearReuse = () => {
    setForm((prev) => {
      const blank = emptyMintForm();
      return {
        ...blank,
        treasuryId:
          treasuries.length === 1 ? (treasuries[0]?.id ?? "") : prev.treasuryId,
      };
    });
    setValidationError(null);
  };

  useEffect(() => {
    if (!reuseSeed || appliedNonce.current === reuseSeed.nonce) return;
    appliedNonce.current = reuseSeed.nonce;
    setForm((prev) => ({
      ...prev,
      ...mintFormFromRow(reuseSeed.row, reuseSeed.mode, nowMs),
    }));
    setValidationError(null);
    requestAnimationFrame(() => {
      cardRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    });
  }, [reuseSeed, nowMs]);

  const selectedTreasury = treasuries.find((t) => t.id === form.treasuryId) ?? null;
  const canMintHere =
    !!selectedTreasury && actsForTreasury({ signerTreasuryIds }, selectedTreasury.id);
  // A lock-until treasury mints nothing before its date; a co-signer
  // treasury offers the co-signed path (default) or the bypass.
  const [path, setPath] = useState<SpendingPath | "">("");
  const offered = selectedTreasury ? offeredPaths(selectedTreasury, TxKind.Mint, nowMs) : { paths: [], blocked: null };
  const chosenPath = path && offered.paths.includes(path) ? path : offered.paths[0];
  const lockedPolicies = useMemo(
    () => lockedPoliciesFor(mints, form.treasuryId, nowMs),
    [mints, form.treasuryId, nowMs],
  );
  const identityLocked = form.reuse?.mode === "mint_more";

  function submit() {
    const problem = validateMintForm(form, { canMintHere, now: Date.now() });
    setValidationError(problem);
    if (problem) return;
    onBuild({ ...buildMintRequest(form), path: chosenPath });
  }

  return (
    <div ref={cardRef} id={MINT_FORM_ANCHOR_ID} className="scroll-mt-4">
      <Card className="space-y-5">
        {form.reuse && (
          <div className="flex flex-wrap items-start justify-between gap-3 rounded-lg border border-zinc-700 bg-zinc-900/60 px-3 py-2">
            <p className="text-sm text-zinc-300">{reuseBannerText(form.reuse, form.policyMode)}</p>
            <Button type="button" variant="ghost" onClick={clearReuse}>
              Start blank
            </Button>
          </div>
        )}

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Minting treasury (policy)">
            <Select
              value={form.treasuryId}
              onChange={(e) =>
                patch({
                  treasuryId: e.target.value,
                  existingLock: NEW_LOCK,
                  // Changing treasury breaks mint-more identity; drop the reuse banner.
                  ...(identityLocked ? { reuse: null } : {}),
                })
              }
              disabled={identityLocked}
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
                  disabled={identityLocked}
                  onClick={() => patch({ kind: k.value })}
                  className={`flex-1 rounded-md px-3 py-1.5 text-sm transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
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
            identityLocked={identityLocked}
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
          policyLocked={identityLocked}
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
    </div>
  );
}
