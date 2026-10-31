"use client";

import { use, useEffect, useMemo, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, apiFetch } from "@/lib/api/client";
import type {
  CreateTreasuryResponse,
  ListSignerDraftsResponse,
  SignerDraftResponse,
  SignerDraftView,
} from "@/lib/api/types";
import { readConnectedSignerKeys } from "@/lib/cardano/connectedSignerKeys";
import { CosignerKind, TreasuryTemplate } from "@/lib/constants";
import { shortAddress } from "@/lib/format";
import { SIGNER_DRAFT_DAYS } from "@/lib/invites/options";
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
import { Button, Card, ConfirmDialog, CopyButton, ErrorText, Field, Input, PageTitle, WarningText } from "@/components/ui";

export default function NewTreasury({
  params,
  searchParams,
}: {
  params: Promise<{ slug: string }>;
  searchParams: Promise<{ draftId?: string | string[] }>;
}) {
  const { slug } = use(params);
  const query = use(searchParams);
  const draftIdParam = typeof query.draftId === "string" ? query.draftId : null;
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
  const [active, setActive] = useState<SignerDraftView | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [ownKeyError, setOwnKeyError] = useState<string | null>(null);
  const keyAttempt = useRef("");
  // Continue from the Treasury list (?draftId=) adopts once; then strip the query.
  const adoptedQuery = useRef<string | null>(null);
  const workgroups = useWorkgroups(community?.id);
  const members = useCommunityMembers(community?.id);
  const leads = useAsyncData(community?.id, async () => {
    const { data } = await browserClient()
      .from("workgroup_leads")
      .select("wallet_address, workgroups!inner(community_id)")
      .eq("workgroups.community_id", community!.id);
    return new Set((data ?? []).map((r) => r.wallet_address as string));
  });
  const openDrafts = useAsyncData(community?.id ?? null, async () =>
    apiFetch<ListSignerDraftsResponse>("/api/treasury/signer-draft", {
      query: { communityId: community!.id },
    }),
  );
  const { run, busy, error } = useAsyncAction("Failed to create treasury");
  const invite = useAsyncAction("Could not save the signer invite");
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

  // Other signers connect on their own; refresh this page's status while any slot is open.
  const activeId = active?.id ?? null;
  useEffect(() => {
    if (!activeId) return;
    const timer = window.setInterval(() => {
      void apiFetch<SignerDraftResponse>("/api/treasury/signer-draft", { query: { draftId: activeId } })
        .then((res) => setActive(res.draft))
        .catch(() => undefined);
    }, 5000);
    return () => window.clearInterval(timer);
  }, [activeId]);

  // The admin's own wallet, when it is a listed signer, is read the same way.
  useEffect(() => {
    if (!sdk || !active || !meshWallet || !sessionWallet) return;
    const mine = active.signers.find((s) => s.address === sessionWallet);
    if (!mine || mine.stakeReceived) return;
    const attempt = `${active.id}:${sessionWallet}`;
    if (keyAttempt.current === attempt) return;
    keyAttempt.current = attempt;
    const draftId = active.id;
    void (async () => {
      try {
        const keys = await readConnectedSignerKeys(meshWallet);
        if (!keys.stakeAddress) {
          setOwnKeyError("This wallet did not provide a stake address, so it cannot complete an SDK signer slot.");
          return;
        }
        setOwnKeyError(null);
        const res = await apiFetch<SignerDraftResponse>("/api/treasury/signer-draft/keys", {
          body: {
            draftId,
            stakeAddress: keys.stakeAddress,
            ...(keys.drepKeyHash ? { drepKeyHash: keys.drepKeyHash } : {}),
          },
        });
        setActive(res.draft);
      } catch {
        // "Send my keys" clears the attempt so this can run again.
      }
    })();
  }, [sdk, active, meshWallet, sessionWallet]);

  // Treasury list Continue links here with ?draftId=; restore that invite once.
  useEffect(() => {
    if (!draftIdParam || !openDrafts.data) return;
    if (adoptedQuery.current === draftIdParam) return;
    adoptedQuery.current = draftIdParam;
    const match = openDrafts.data.drafts.find((d) => d.id === draftIdParam);
    if (match) {
      setActive(match);
      setEnableSdk(true);
      setName(match.name);
      setRequired(match.required);
      setWorkgroupId(match.workgroupId ?? COMMUNITY_TREASURY);
      setSigners(match.signers.map((s) => ({
        address: s.address,
        name: s.name ?? "",
        stakeAddress: "",
        drepKeyHash: "",
      })));
      setDraft((current) => ({ ...current, template: TreasuryTemplate.Plain }));
      setInviteUrl(null);
      keyAttempt.current = "";
      setOwnKeyError(null);
    }
    router.replace(routes.newTreasury(slug));
  }, [draftIdParam, openDrafts.data, router, slug]);

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
  const formSigners = filled.map((s) => ({ address: s.address.trim(), name: s.name.trim() }));
  const dirty = !!active && (
    name.trim() !== active.name
    || required !== active.required
    || (workgroupId || null) !== active.workgroupId
    || formSigners.length !== active.signers.length
    || formSigners.some((s, i) => s.address !== active.signers[i]?.address || s.name !== (active.signers[i]?.name ?? ""))
  );
  const stakesIn = !!active && active.signers.length > 0 && active.signers.every((s) => s.stakeReceived);
  const sdkReady = !sdk || (stakesIn && !dirty);
  const otherDrafts = (openDrafts.data?.drafts ?? []).filter((d) => d.id !== active?.id);

  function updateSigner(i: number, patch: Partial<SignerDraft>) {
    setSigners((prev) => prev.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  }

  function adopt(next: SignerDraftView) {
    setActive(next);
    setEnableSdk(true);
    setName(next.name);
    setRequired(next.required);
    setWorkgroupId(next.workgroupId ?? COMMUNITY_TREASURY);
    setSigners(next.signers.map((s) => ({
      address: s.address,
      name: s.name ?? "",
      stakeAddress: "",
      drepKeyHash: "",
    })));
    setDraft((current) => ({ ...current, template: TreasuryTemplate.Plain }));
    setInviteUrl(null);
    keyAttempt.current = "";
    setOwnKeyError(null);
  }

  async function listedSigners() {
    let own = { stakeAddress: "", drepKeyHash: "" };
    if (meshWallet && sessionWallet) {
      try {
        own = await readConnectedSignerKeys(meshWallet);
      } catch {
        own = { stakeAddress: "", drepKeyHash: "" };
      }
    }
    return formSigners.map((s) => (
      s.address === sessionWallet && own.stakeAddress
        ? {
            ...s,
            stakeAddress: own.stakeAddress,
            ...(own.drepKeyHash ? { drepKeyHash: own.drepKeyHash } : {}),
          }
        : s
    ));
  }

  async function saveInvite() {
    if (!community) return;
    const result = await invite.run(async () =>
      apiFetch<SignerDraftResponse>("/api/treasury/signer-draft", {
        body: {
          communityId: community.id,
          name: name.trim(),
          required,
          workgroupId: workgroupId || null,
          signers: await listedSigners(),
        },
      }),
    );
    if (!result) return;
    setActive(result.draft);
    setInviteUrl(result.url ?? null);
    keyAttempt.current = "";
    openDrafts.reload();
  }

  async function updateInvite() {
    if (!community || !active) return;
    const result = await invite.run(async () =>
      apiFetch<SignerDraftResponse>("/api/treasury/signer-draft", {
        method: "PATCH",
        body: {
          draftId: active.id,
          communityId: community.id,
          name: name.trim(),
          required,
          workgroupId: workgroupId || null,
          signers: await listedSigners(),
        },
      }),
    );
    if (!result) return;
    setActive(result.draft);
  }

  async function discardInvite(id: string) {
    const ok = await invite.run(async () => {
      await apiFetch("/api/treasury/signer-draft", { method: "DELETE", body: { draftId: id } });
      return true;
    });
    if (!ok) return;
    if (active?.id === id) {
      setActive(null);
      setInviteUrl(null);
      keyAttempt.current = "";
    }
    openDrafts.reload();
  }

  function resendOwnKeys() {
    keyAttempt.current = "";
    setOwnKeyError(null);
    setActive((current) => (current ? { ...current } : current));
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
            signers: formSigners,
            workgroupId: workgroupId || null,
            ...(sdk && active ? { signerDraftId: active.id } : {}),
            ...templateRequest(draft),
          },
        });
      } catch (err) {
        if (err instanceof ApiError && err.body.restoreTreasuryId) setRestoreId(err.body.restoreTreasuryId);
        throw err;
      }
    });
    if (!result) return;
    setActive(null);
    setInviteUrl(null);
    // A requested link has an outcome worth reading (this period, next
    // period, or refused); a community treasury goes straight to the list.
    if (workgroupId) setCreated(result);
    else router.push(routes.treasury(slug));
  }

  return (
    <div className="mx-auto max-w-2xl">
      <PageTitle>New multisig treasury</PageTitle>
      <Card className="space-y-5">
        {otherDrafts.length > 0 && (
          <div className="space-y-2 rounded-lg border border-[var(--border)] p-3 text-sm">
            <p>An SDK signer invite is already open. Continue it, or discard it before starting another.</p>
            {otherDrafts.map((item) => (
              <div key={item.id} className="flex flex-wrap items-center gap-2">
                <span className="font-medium">{item.name}</span>
                <span className="text-zinc-500">
                  {item.signers.filter((s) => s.stakeReceived).length} of {item.signers.length} connected
                </span>
                <Button variant="ghost" disabled={invite.busy} onClick={() => adopt(item)}>
                  Continue
                </Button>
                <Button variant="ghost" disabled={invite.busy} onClick={() => void discardInvite(item.id)}>
                  Discard
                </Button>
              </div>
            ))}
          </div>
        )}

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
            disabled={busy || invite.busy}
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
              const status = active?.signers.find((row) => row.address === s.address.trim());
              return (
                <div key={i} className="space-y-2 rounded-lg border border-[var(--border)] p-3">
                  <SignerMemberPick
                    ariaLabel={`Base signer ${i + 1} member`}
                    members={members.data ?? []}
                    leadWallets={leadWallets}
                    exclude={exclude}
                    disabled={busy || invite.busy}
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
                  {sdk && active && status && (
                    <p className="text-xs text-zinc-500">
                      {status.stakeReceived ? "Stake address received." : "Waiting for this wallet to connect."}
                      {status.drepReceived
                        ? " DRep key received."
                        : " No DRep key yet — the payment script will act as the DRep if none arrives."}
                    </p>
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
              disabled={busy || invite.busy}
              onChange={(e) => setEnableSdk(e.target.checked)}
            />
            <span>
              <span className="font-medium">Enable staking and Cardano governance (SDK wallet).</span>{" "}
              Each base signer connects with the listed wallet so its stake address can be read.
              DRep key hashes are optional; without a full set the payment script acts as the DRep.
              Legacy wallets cannot stake or vote — create a new SDK treasury and move funds instead.
            </span>
          </label>
        )}

        {sdk && active && (
          <div className="space-y-2 rounded-lg border border-[var(--border)] p-3 text-sm">
            <p>
              Signers have {SIGNER_DRAFT_DAYS} days to open the invite and connect.
              {active.signers.filter((s) => s.stakeReceived).length} of {active.signers.length} stake addresses are in.
            </p>
            <ul className="space-y-1 text-xs text-zinc-400">
              {active.signers.map((s) => (
                <li key={s.address}>
                  <span className="font-mono">{shortAddress(s.address)}</span>
                  {" — "}
                  {s.stakeReceived ? "stake received" : "waiting"}
                  {s.drepReceived ? ", DRep key received" : ""}
                </li>
              ))}
            </ul>
            {inviteUrl ? (
              <div className="flex flex-wrap items-center gap-2">
                <Input readOnly className="font-mono text-xs" value={inviteUrl} />
                <CopyButton value={inviteUrl} label="Copy invite link" />
              </div>
            ) : (
              <p className="text-xs text-zinc-500">
                The link is shown once, when the invite is saved. Discard this invite to make a new link.
              </p>
            )}
            {ownKeyError && <p className="text-xs text-red-400">{ownKeyError}</p>}
            {sessionWallet && active.signers.some((s) => s.address === sessionWallet && !s.stakeReceived) && (
              <Button variant="ghost" disabled={invite.busy} onClick={resendOwnKeys}>
                Send my keys
              </Button>
            )}
            <Button variant="ghost" disabled={invite.busy} onClick={() => void discardInvite(active.id)}>
              Discard invite
            </Button>
          </div>
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
          disabled={busy || invite.busy}
        />

        <WarningText small>{networkReason}</WarningText>
        <ErrorText error={error ?? invite.error} />
        {restoreId && <RestoreArchivedTreasury slug={slug} treasuryId={restoreId} />}
        {sdk && !active && (
          <Button
            onClick={() => void saveInvite()}
            disabled={!name.trim() || filled.length === 0 || !!networkReason || invite.busy}
            loading={invite.busy}
          >
            {invite.busy ? "Saving invite…" : "Save and invite signers"}
          </Button>
        )}
        {sdk && active && dirty && (
          <Button
            onClick={() => void updateInvite()}
            disabled={!name.trim() || filled.length === 0 || !!networkReason || invite.busy}
            loading={invite.busy}
          >
            {invite.busy ? "Updating invite…" : "Update invite"}
          </Button>
        )}
        {(!sdk || active) && (
          <Button
            onClick={() => (plain ? void submit() : setConfirming(true))}
            disabled={!name || filled.length === 0 || !!networkReason || !templateComplete(draft) || !sdkReady || busy}
            loading={busy}
          >
            {busy ? "Deriving script address…" : "Create treasury"}
          </Button>
        )}
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
