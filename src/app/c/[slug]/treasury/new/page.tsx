"use client";

import { use, useEffect, useMemo, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, apiFetch } from "@/lib/api/client";
import type { CreateTreasuryResponse } from "@/lib/api/types";
import { CosignerKind, TreasuryTemplate } from "@/lib/constants";
import { templateLabel } from "@/lib/cardano/spendingPaths";
import { describeThreshold } from "@/lib/cardano/thresholds";
import { routes } from "@/lib/routes";
import { browserClient } from "@/lib/supabase/browser";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useAsyncData } from "@/hooks/useAsyncData";
import { useCommunityGate } from "@/hooks/useCommunityGate";
import { useCommunityMembers } from "@/hooks/useCommunityMembers";
import { useNetworkGate } from "@/hooks/useNetworkGate";
import { useSession } from "@/hooks/useSession";
import { useWorkgroups } from "@/hooks/useWorkgroups";
import {
  emptySigner,
  emptyTemplateDraft,
  TemplateFields,
  templateComplete,
  templateRequest,
  templateSummary,
  type SignerDraft,
  type TemplateDraft,
} from "@/components/treasury/TemplateFields";
import { RestoreArchivedTreasury } from "@/components/treasury/RestoreArchivedTreasury";
import { SignerMemberPick } from "@/components/treasury/SignerMemberPick";
import {
  COMMUNITY_TREASURY,
  TreasuryCreatedNotice,
  TreasuryLinkField,
} from "@/components/treasury/TreasuryWorkgroupLink";
import { Button, Card, ConfirmDialog, ErrorText, Field, Input, PageTitle, WarningText } from "@/components/ui";

export default function NewTreasury({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const router = useRouter();
  const { community, blocked } = useCommunityGate(slug, { require: "admin" });
  const { wallet: meshWallet, walletAddress: sessionWallet } = useSession();
  const [name, setName] = useState("");
  const [signers, setSigners] = useState<SignerDraft[]>([
    emptySigner(),
    emptySigner(),
  ]);
  const [required, setRequired] = useState(2);
  const [draft, setDraft] = useState<TemplateDraft>(emptyTemplateDraft);
  const [enableSdk, setEnableSdk] = useState(false);
  const [confirming, setConfirming] = useState(false);
  const [workgroupId, setWorkgroupId] = useState(COMMUNITY_TREASURY);
  const [created, setCreated] = useState<CreateTreasuryResponse | null>(null);
  const [restoreId, setRestoreId] = useState<string | null>(null);
  const workgroups = useWorkgroups(community?.id);
  const members = useCommunityMembers(community?.id);
  const leads = useAsyncData(community?.id, async () => {
    const { data } = await browserClient()
      .from("workgroup_leads")
      .select("wallet_address, workgroups!inner(community_id)")
      .eq("workgroups.community_id", community!.id);
    return new Set((data ?? []).map((r) => r.wallet_address as string));
  });
  const { run, busy, error } = useAsyncAction("Failed to create treasury");
  // The creator must be a signer of the first treasury, and every signer
  // address must be on the community's network — so the wallet must be too.
  const { reason: networkReason } = useNetworkGate(community?.network);
  const usedWallets = useMemo(() => {
    const used = new Set<string>();
    for (const s of signers) {
      const a = s.address.trim();
      if (a) used.add(a);
    }
    for (const s of draft.recoverySigners) {
      const a = s.address.trim();
      if (a) used.add(a);
    }
    if (draft.cosignerKind === CosignerKind.Member && draft.cosignerAddress.trim()) {
      used.add(draft.cosignerAddress.trim());
    }
    return used;
  }, [signers, draft.recoverySigners, draft.cosignerKind, draft.cosignerAddress]);

  const plain = draft.template === TreasuryTemplate.Plain;
  const sdk = plain && enableSdk;
  useEffect(() => {
    if (!sdk || !meshWallet || !sessionWallet) return;
    void (async () => {
      try {
        const rewards = await meshWallet.getRewardAddresses();
        const stakeAddress = rewards[0] ?? "";
        let drepKeyHash = "";
        const anyWallet = meshWallet as { getDRep?: () => Promise<{ publicKeyHash?: string } | undefined> };
        if (typeof anyWallet.getDRep === "function") {
          const drep = await anyWallet.getDRep();
          drepKeyHash = drep?.publicKeyHash ?? "";
        }
        setSigners((prev) =>
          prev.map((s) =>
            s.address.trim() === sessionWallet
              ? {
                  ...s,
                  stakeAddress: s.stakeAddress || stakeAddress,
                  drepKeyHash: s.drepKeyHash || drepKeyHash,
                }
              : s,
          ),
        );
      } catch {
        // Connected wallet may lack stake/DRep; paste stays available.
      }
    })();
  }, [sdk, meshWallet, sessionWallet]);

  if (blocked) return blocked;

  const workgroupList = workgroups.data ?? [];
  if (created) {
    return (
      <div className="mx-auto max-w-2xl">
        <PageTitle>New multisig treasury</PageTitle>
        <TreasuryCreatedNotice
          slug={slug}
          result={created}
          workgroupName={workgroupList.find((w) => w.id === workgroupId)?.name ?? "the workgroup"}
        />
      </div>
    );
  }

  const filled = signers.filter((s) => s.address.trim());
  const baseRule = describeThreshold("atLeast", required, filled.length);
  const becomesPrimary = !community?.primary_treasury_id;
  const leadWallets = leads.data ?? new Set<string>();
  const sdkReady = !sdk || filled.every((s) => s.stakeAddress.trim());

  function updateSigner(i: number, patch: Partial<SignerDraft>) {
    setSigners((prev) => prev.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  }

  async function submit() {
    setConfirming(false);
    setRestoreId(null);
    const result = await run(async () => {
      try {
        return await apiFetch<CreateTreasuryResponse>("/api/treasury", {
          body: {
            communityId: community!.id,
            name,
            required,
            signers: filled.map((s) => ({
              address: s.address.trim(),
              name: s.name.trim(),
              ...(sdk
                ? {
                    stakeAddress: s.stakeAddress.trim(),
                    ...(s.drepKeyHash.trim() ? { drepKeyHash: s.drepKeyHash.trim() } : {}),
                  }
                : {}),
            })),
            workgroupId: workgroupId || null,
            ...templateRequest(draft),
          },
        });
      } catch (err) {
        if (err instanceof ApiError && err.body.restoreTreasuryId) setRestoreId(err.body.restoreTreasuryId);
        throw err;
      }
    });
    if (!result) return;
    // A requested link has an outcome worth reading (this period, next
    // period, or refused); a community treasury goes straight to the list.
    if (workgroupId) setCreated(result);
    else router.push(routes.treasury(slug));
  }

  return (
    <div className="mx-auto max-w-2xl">
      <PageTitle>New multisig treasury</PageTitle>
      <Card className="space-y-5">
        <Field label="Name">
          <Input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Main treasury"
          />
        </Field>

        {workgroupList.length > 0 && (
          <TreasuryLinkField
            workgroups={workgroupList}
            value={workgroupId}
            disabled={busy}
            onChange={setWorkgroupId}
          />
        )}

        <Field
          label={plain ? "Signers (payment addresses)" : "Base signers (payment addresses)"}
          hint={
            becomesPrimary
              ? "This is the community's primary treasury: each base signer becomes a community admin. Pick a member or paste a payment address."
              : "Base signers can spend from this treasury only; they are not made community admins. Pick a member or paste a payment address."
          }
        >
          <div className="space-y-2">
            {signers.map((s, i) => {
              const exclude = new Set(usedWallets);
              if (s.address.trim()) exclude.delete(s.address.trim());
              return (
                <div key={i} className="space-y-2 rounded-lg border border-[var(--border)] p-3">
                  <SignerMemberPick
                    ariaLabel={`Base signer ${i + 1} member`}
                    members={members.data ?? []}
                    leadWallets={leadWallets}
                    exclude={exclude}
                    disabled={busy}
                    onPick={(draftSigner) => updateSigner(i, draftSigner)}
                  />
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <Input
                      className="font-mono text-xs"
                      value={s.address}
                      onChange={(e) => updateSigner(i, { address: e.target.value })}
                      placeholder="addr… / addr_test…"
                    />
                    <Input
                      className="sm:max-w-32"
                      value={s.name}
                      onChange={(e) => updateSigner(i, { name: e.target.value })}
                      placeholder="Name"
                    />
                  </div>
                  {sdk && (
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <Input
                        className="font-mono text-xs"
                        value={s.stakeAddress}
                        onChange={(e) => updateSigner(i, { stakeAddress: e.target.value })}
                        placeholder="stake… / stake_test…"
                      />
                      <Input
                        className="font-mono text-xs sm:max-w-56"
                        value={s.drepKeyHash}
                        onChange={(e) => updateSigner(i, { drepKeyHash: e.target.value })}
                        placeholder="DRep key hash (optional)"
                      />
                    </div>
                  )}
                </div>
              );
            })}
          </div>
          <Button
            variant="ghost"
            className="mt-2"
            onClick={() => setSigners((prev) => [...prev, emptySigner()])}
          >
            + Add signer
          </Button>
        </Field>

        {plain && (
          <label className="flex items-start gap-2 text-sm">
            <input
              type="checkbox"
              className="mt-1"
              checked={enableSdk}
              disabled={busy}
              onChange={(e) => setEnableSdk(e.target.checked)}
            />
            <span>
              <span className="font-medium">Enable staking and Cardano governance (SDK wallet).</span>{" "}
              Every base signer needs a stake address. DRep key hashes are optional; without a full set the payment script acts as the DRep. Legacy wallets cannot stake or vote — create a new SDK treasury and move funds instead.
            </span>
          </label>
        )}

        <Field label={`Required signatures (${required} of ${filled.length})`}>
          <Input
            type="number"
            min={1}
            max={Math.max(filled.length, 1)}
            value={required}
            onChange={(e) => setRequired(Number(e.target.value))}
          />
        </Field>

        <TemplateFields
          draft={draft}
          onChange={(patch) => setDraft((d) => ({ ...d, ...patch }))}
          members={members.data ?? []}
          leadWallets={leadWallets}
          usedWallets={usedWallets}
          disabled={busy}
        />

        <WarningText small>{networkReason}</WarningText>
        <ErrorText error={error} />
        {restoreId && <RestoreArchivedTreasury slug={slug} treasuryId={restoreId} />}
        <Button
          onClick={() => (plain ? void submit() : setConfirming(true))}
          disabled={!name || filled.length === 0 || !!networkReason || !templateComplete(draft) || !sdkReady}
          loading={busy}
        >
          {busy ? "Deriving script address…" : "Create treasury"}
        </Button>
        <p className="text-xs text-zinc-500">
          The multisig address is derived deterministically from the signers&apos;
          payment key hashes (CIP-1854 ordering). Funds sent to it can only move
          with {required} signature(s){plain ? "" : " under the base rule"}.
        </p>
      </Card>

      <ConfirmDialog
        open={confirming}
        title={`Create a ${templateLabel(draft.template).toLowerCase()} treasury?`}
        confirmLabel="Create treasury"
        danger={false}
        busy={busy}
        onConfirm={() => void submit()}
        onCancel={() => setConfirming(false)}
      >
        <ul className="list-disc space-y-1 pl-5">
          {templateSummary(draft, baseRule).map((line, i) => <li key={i}>{line}</li>)}
        </ul>
      </ConfirmDialog>
    </div>
  );
}
