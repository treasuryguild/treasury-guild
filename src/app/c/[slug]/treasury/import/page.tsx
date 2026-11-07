"use client";

import { use, useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, apiFetch } from "@/lib/api/client";
import type {
  Cip146LookupResponse,
  CreateTreasuryResponse,
  ImportDraftResponse,
  ImportDraftView,
  TreasuryImportPreview,
} from "@/lib/api/types";
import { paymentKeyHash } from "@/lib/cardano/multisigSDK";
import { templateLabel } from "@/lib/cardano/spendingPaths";
import { describeThreshold } from "@/lib/cardano/thresholds";
import { asNetwork, networkName } from "@/lib/config";
import { SignerGroup, TreasuryTemplate } from "@/lib/constants";
import { formatDate, shortHash } from "@/lib/format";
import { IMPORT_DRAFT_DAYS } from "@/lib/invites/options";
import { routes } from "@/lib/routes";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useCommunityGate } from "@/hooks/useCommunityGate";
import { useNetworkGate } from "@/hooks/useNetworkGate";
import { useSession } from "@/hooks/useSession";
import { useWorkgroups } from "@/hooks/useWorkgroups";
import { RestoreArchivedTreasury } from "@/components/treasury/RestoreArchivedTreasury";
import { COMMUNITY_TREASURY, TreasuryCreatedNotice, TreasuryLinkField } from "@/components/treasury/TreasuryWorkgroupLink";
import { Button, Card, CopyButton, ErrorText, Field, Input, LinkButton, PageTitle, Select, Textarea, WarningText } from "@/components/ui";

const GROUP_LABELS: Record<SignerGroup, string> = {
  [SignerGroup.Base]: "Signer",
  [SignerGroup.Recovery]: "Recovery signer",
  [SignerGroup.Cosigner]: "Co-signer",
};

type ImportMethod = "cbor" | "discover";

function queryHashes(input: string, sessionWallet: string | null): string[] {
  const trimmed = input.trim();
  if (!trimmed) {
    if (!sessionWallet) return [];
    try {
      return [paymentKeyHash(sessionWallet).toLowerCase()];
    } catch {
      return [];
    }
  }
  if (/^[0-9a-f]{56}$/i.test(trimmed)) return [trimmed.toLowerCase()];
  try {
    return [paymentKeyHash(trimmed).toLowerCase()];
  } catch {
    return [];
  }
}

export default function ImportTreasury({
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
  const { reason: networkReason } = useNetworkGate(community?.network);
  const { sessionWallet } = useSession();
  const workgroups = useWorkgroups(community?.id);
  const [method, setMethod] = useState<ImportMethod>("cbor");
  const [name, setName] = useState("");
  const [cbor, setCbor] = useState("");
  const [discoverQuery, setDiscoverQuery] = useState("");
  const [matches, setMatches] = useState<Cip146LookupResponse["registrations"] | null>(null);
  const [preview, setPreview] = useState<TreasuryImportPreview | null>(null);
  const [previewSource, setPreviewSource] = useState<
    | { type: "cbor"; cbor: string; stakeCredentialHash?: string }
    | { type: "cip146"; txHash: string }
    | null
  >(null);
  const [draft, setDraft] = useState<ImportDraftView | null>(null);
  const [inviteUrl, setInviteUrl] = useState<string | null>(null);
  const [pasteAddresses, setPasteAddresses] = useState("");
  const [workgroupId, setWorkgroupId] = useState(COMMUNITY_TREASURY);
  const [created, setCreated] = useState<CreateTreasuryResponse | null>(null);
  const [restoreId, setRestoreId] = useState<string | null>(null);
  const review = useAsyncAction("Failed to read treasury");
  const discover = useAsyncAction("Failed to search on-chain registrations");
  const invite = useAsyncAction("Could not save the import invite");
  const slot = useAsyncAction("Could not match signer addresses");
  const save = useAsyncAction("Failed to import treasury");
  const busy = review.busy || discover.busy || invite.busy || slot.busy || save.busy;
  const adoptedQuery = useRef<string | null>(null);

  function clearPreview() {
    setPreview(null);
    setPreviewSource(null);
    setDraft(null);
    setInviteUrl(null);
    setPasteAddresses("");
    review.setError(null);
    invite.setError(null);
    slot.setError(null);
    save.setError(null);
  }

  function applyPreview(
    result: TreasuryImportPreview,
    source: { type: "cbor"; cbor: string; stakeCredentialHash?: string } | { type: "cip146"; txHash: string },
  ) {
    setPreview(result);
    setPreviewSource(source);
    setDraft(null);
    setInviteUrl(null);
    setPasteAddresses("");
    if (!name.trim() && result.suggestedName) setName(result.suggestedName);
  }

  async function readScript() {
    const result = await review.run(() => apiFetch<TreasuryImportPreview>("/api/treasury/import/preview", {
      body: { communityId: community!.id, source: { type: "cbor", cbor } },
    }));
    if (!result) return;
    applyPreview(result, { type: "cbor", cbor: result.scriptCbor });
  }

  async function searchRegistrations() {
    const hashes = queryHashes(discoverQuery, sessionWallet);
    if (hashes.length === 0) {
      discover.setError("Connect a wallet or paste a payment address / key hash to search");
      return;
    }
    setMatches(null);
    clearPreview();
    const result = await discover.run(() =>
      apiFetch<Cip146LookupResponse>("/api/chain/cip146/lookup", {
        query: { network: community!.network, pubKeyHashes: hashes.join(",") },
      }),
    );
    if (!result) return;
    setMatches(result.registrations);
  }

  async function pickRegistration(txHash: string) {
    clearPreview();
    const result = await review.run(() => apiFetch<TreasuryImportPreview>("/api/treasury/import/preview", {
      body: { communityId: community!.id, source: { type: "cip146", txHash } },
    }));
    if (!result) return;
    applyPreview(result, { type: "cip146", txHash });
  }

  async function previewByTxHash(raw: string) {
    const txHash = raw.trim().toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(txHash)) {
      discover.setError("Paste a 64-character transaction hash, a payment address, or a 56-character key hash");
      return;
    }
    setMatches(null);
    await pickRegistration(txHash);
  }

  async function saveAndInvite() {
    if (!preview || !previewSource) return;
    const signerNames: Record<string, string> = {};
    for (const s of preview.signers) {
      if (s.name.trim()) signerNames[s.keyHash] = s.name.trim();
    }
    const result = await invite.run(() =>
      apiFetch<ImportDraftResponse>("/api/treasury/import-draft", {
        body: {
          communityId: community!.id,
          name: name.trim(),
          workgroupId: workgroupId || null,
          source: previewSource.type === "cbor"
            ? {
                type: "cbor",
                cbor: preview.scriptCbor,
                ...(preview.stakeCredentialHash
                  ? { stakeCredentialHash: preview.stakeCredentialHash }
                  : {}),
              }
            : previewSource,
          ...(Object.keys(signerNames).length > 0 ? { signerNames } : {}),
        },
      }),
    );
    if (!result) return;
    setDraft(result.draft);
    setInviteUrl(result.url ?? null);
    setName(result.draft.name);
    setWorkgroupId(result.draft.workgroupId ?? COMMUNITY_TREASURY);
  }

  async function matchAddresses() {
    if (!draft) return;
    const addresses = pasteAddresses.split(/[\s,]+/).map((a) => a.trim()).filter(Boolean);
    if (addresses.length === 0) return;
    const result = await slot.run(() =>
      apiFetch<ImportDraftResponse>("/api/treasury/import-draft/slot", {
        body: {
          draftId: draft.id,
          communityId: community!.id,
          addresses,
        },
      }),
    );
    if (!result) return;
    setDraft(result.draft);
    setPasteAddresses("");
  }

  async function refreshDraft() {
    if (!draft) return;
    const result = await apiFetch<ImportDraftResponse>("/api/treasury/import-draft", {
      query: { draftId: draft.id },
    });
    setDraft(result.draft);
  }

  useEffect(() => {
    if (!draft || draft.filled >= draft.total) return;
    const id = window.setInterval(() => {
      void refreshDraft().catch(() => undefined);
    }, 5_000);
    return () => window.clearInterval(id);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- poll the open draft only
  }, [draft?.id, draft?.filled, draft?.total]);

  useEffect(() => {
    if (!community || !draftIdParam || adoptedQuery.current === draftIdParam) return;
    adoptedQuery.current = draftIdParam;
    void (async () => {
      const result = await invite.run(() =>
        apiFetch<ImportDraftResponse>("/api/treasury/import-draft", {
          query: { draftId: draftIdParam },
        }),
      );
      if (!result) return;
      setDraft(result.draft);
      setName(result.draft.name);
      setWorkgroupId(result.draft.workgroupId ?? COMMUNITY_TREASURY);
      setPreview({
        address: "",
        scriptCbor: result.draft.scriptCbor,
        stakeCredentialHash: result.draft.stakeCredentialHash,
        suggestedName: result.draft.name,
        template: TreasuryTemplate.Plain,
        scriptType: "atLeast",
        required: 1,
        recovery: null,
        lockSlot: null,
        lockUntil: null,
        signers: result.draft.signers.map((s) => ({
          keyHash: s.keyHash,
          address: s.address ?? "",
          group: s.group,
          name: s.name ?? "",
        })),
      });
      setPreviewSource({
        type: "cbor",
        cbor: result.draft.scriptCbor,
        ...(result.draft.stakeCredentialHash
          ? { stakeCredentialHash: result.draft.stakeCredentialHash }
          : {}),
      });
      setMethod("cbor");
      setCbor(result.draft.scriptCbor);
      router.replace(routes.importTreasury(slug));
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- adopt ?draftId= once
  }, [community?.id, draftIdParam]);

  async function submit() {
    if (!draft || !previewSource) return;
    setRestoreId(null);
    const result = await save.run(async () => {
      try {
        const source = previewSource.type === "cbor"
          ? {
              type: "cbor" as const,
              cbor: draft.scriptCbor,
              ...(draft.stakeCredentialHash
                ? { stakeCredentialHash: draft.stakeCredentialHash }
                : {}),
            }
          : previewSource;
        return await apiFetch<CreateTreasuryResponse>("/api/treasury", {
          body: {
            communityId: community!.id,
            name: draft.name,
            source,
            importDraftId: draft.id,
            workgroupId: draft.workgroupId,
          },
        });
      } catch (err) {
        if (err instanceof ApiError && err.body.restoreTreasuryId) setRestoreId(err.body.restoreTreasuryId);
        throw err;
      }
    });
    if (!result) return;
    if (draft.workgroupId) setCreated(result);
    else router.push(routes.treasury(slug));
  }

  const activeSigners = draft?.signers ?? preview?.signers.map((s) => ({
    keyHash: s.keyHash,
    group: s.group,
    address: s.address || null,
    name: s.name || null,
    claimed: Boolean(s.address),
  })) ?? [];
  const baseCount = activeSigners.filter((s) => s.group === SignerGroup.Base).length;
  const recoveryCount = activeSigners.filter((s) => s.group === SignerGroup.Recovery).length;
  const groupNumber = (i: number) =>
    activeSigners.slice(0, i).filter((s) => s.group === activeSigners[i]!.group).length + 1;
  const complete = Boolean(draft && draft.filled === draft.total);

  if (blocked) return blocked;

  return (
    <div className="mx-auto max-w-2xl">
      <PageTitle action={<LinkButton href={routes.treasury(slug)} variant="ghost">Back to treasury</LinkButton>}>
        Import treasury
      </PageTitle>
      {created ? (
        <TreasuryCreatedNotice slug={slug} result={created}
          workgroupName={workgroups.data?.find((w) => w.id === draft?.workgroupId)?.name ?? "the workgroup"} />
      ) : (
        <Card className="space-y-5">
          {!draft && (
            <>
              <Field label="Import method">
                <Select
                  aria-label="Import method"
                  value={method}
                  disabled={busy}
                  onChange={(e) => {
                    setMethod(e.target.value as ImportMethod);
                    setMatches(null);
                    clearPreview();
                    discover.setError(null);
                  }}
                >
                  <option value="cbor">Native script CBOR</option>
                  <option value="discover">Discover on-chain (CIP-0146)</option>
                </Select>
              </Field>
              <Field label="Name">
                <Input aria-label="Name" value={name} disabled={busy}
                  onChange={(e) => setName(e.target.value)} placeholder="Main treasury" />
              </Field>

              {method === "cbor" ? (
                <>
                  <Field label="Native script (CBOR hex)" hint="Paste the payment script: a flat all, any or at-least multisig, or one of Treasury Guild's clawback, lock-until or co-signer shapes.">
                    <Textarea aria-label="Native script (CBOR hex)" value={cbor} rows={5} maxLength={65_536}
                      disabled={busy} spellCheck={false} className="font-mono text-xs" placeholder="83030283…"
                      onChange={(e) => {
                        setCbor(e.target.value); clearPreview();
                      }} />
                  </Field>
                  <ErrorText error={review.error} />
                  <Button variant="secondary" onClick={() => void readScript()} loading={review.busy}
                    disabled={busy || !cbor.trim()}>Read CBOR</Button>
                </>
              ) : (
                <>
                  <Field
                    label="Search"
                    hint="Leave blank to search with your connected wallet's payment key. Or paste a payment address, key hash, or a registration transaction hash."
                  >
                    <Input
                      aria-label="Discover query"
                      value={discoverQuery}
                      disabled={busy}
                      className="font-mono text-xs"
                      placeholder="addr… / key hash / tx hash"
                      onChange={(e) => {
                        setDiscoverQuery(e.target.value);
                        setMatches(null);
                        clearPreview();
                        discover.setError(null);
                      }}
                    />
                  </Field>
                  <ErrorText error={discover.error} />
                  <ErrorText error={review.error} />
                  <div className="flex flex-wrap gap-2">
                    <Button
                      variant="secondary"
                      loading={discover.busy}
                      disabled={busy}
                      onClick={() => {
                        const q = discoverQuery.trim();
                        if (/^[0-9a-f]{64}$/i.test(q)) void previewByTxHash(q);
                        else void searchRegistrations();
                      }}
                    >
                      {/^[0-9a-f]{64}$/i.test(discoverQuery.trim()) ? "Resolve registration" : "Search registrations"}
                    </Button>
                  </div>
                  {matches && (
                    <div className="space-y-2">
                      <p className="text-sm text-zinc-400">
                        {matches.length === 0
                          ? "No on-chain registrations reference those keys yet. A treasury can be registered from its Details dialog."
                          : `${matches.length} registration${matches.length === 1 ? "" : "s"} found`}
                      </p>
                      {matches.map((m) => (
                        <div key={m.txHash} className="flex flex-wrap items-center justify-between gap-2 rounded-lg border border-zinc-700 px-3 py-2">
                          <div className="min-w-0">
                            <p className="truncate text-sm font-medium">{m.name || "Unnamed treasury"}</p>
                            <p className="font-mono text-xs text-zinc-500">{shortHash(m.txHash)}</p>
                          </div>
                          <Button
                            variant="secondary"
                            disabled={busy}
                            loading={review.busy}
                            onClick={() => void pickRegistration(m.txHash)}
                          >
                            Import
                          </Button>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </>
          )}

          {preview && (
            <>
              <div className="space-y-2 rounded-lg border border-zinc-700 p-4">
                {preview.address ? (
                  <>
                    <p className="text-sm">Template: {templateLabel(preview.template)}</p>
                    <p className="text-sm">Signing rule: {describeThreshold(preview.scriptType, preview.required, baseCount)}</p>
                    {preview.recovery && (
                      <p className="text-sm">Recovery rule: {describeThreshold(preview.recovery.scriptType, preview.recovery.required, recoveryCount)}</p>
                    )}
                    {preview.lockUntil && (
                      <p className="text-sm">
                        {preview.template === TreasuryTemplate.LockUntil ? "Locked until" : "Recovery from"}{" "}
                        {formatDate(preview.lockUntil, "datetime")} (slot {preview.lockSlot})
                      </p>
                    )}
                    <p className="text-sm">Treasury address ({networkName(asNetwork(community!.network))})</p>
                    <p className="break-all font-mono text-xs">{preview.address}</p>
                    <CopyButton value={preview.address} label="Copy treasury address" />
                    <p className="text-xs text-zinc-500">
                      {preview.stakeCredentialHash
                        ? "This registration includes a stake credential; the address above should match the on-chain wallet."
                        : "Check this matches the treasury you want to import. CBOR contains no network or staking credential; this imports an unstaked address on the community's network."}
                    </p>
                  </>
                ) : (
                  <p className="text-sm text-zinc-400">
                    Continuing import invite <span className="font-medium text-zinc-200">{draft?.name}</span>.
                    {" "}{draft?.filled ?? 0} of {draft?.total ?? 0} signers claimed.
                  </p>
                )}
              </div>

              {!draft ? (
                <>
                  <p className="text-sm text-zinc-400">
                    Save an invite so each signer can connect their wallet and claim their key.
                    Your connected wallet must be a base signer (claimed when you save).
                    You can also paste the other signers&apos; payment addresses in any order;
                    Treasury Guild matches them to the script keys.
                    The invite lasts {IMPORT_DRAFT_DAYS} days.
                  </p>
                  {!!workgroups.data?.length && <TreasuryLinkField workgroups={workgroups.data} value={workgroupId}
                    disabled={busy} onChange={setWorkgroupId} />}
                  <ErrorText error={invite.error} />
                  <Button onClick={() => void saveAndInvite()} loading={invite.busy}
                    disabled={busy || !name.trim() || !!networkReason}>
                    Save and invite
                  </Button>
                </>
              ) : (
                <>
                  <div className="space-y-2">
                    <p className="text-sm text-zinc-400">
                      {draft.filled} of {draft.total} signers claimed. Share the invite link so the others can connect,
                      or paste their payment addresses in any order below.
                    </p>
                    {inviteUrl && (
                      <div className="flex flex-wrap items-center gap-2">
                        <Input aria-label="Invite URL" readOnly value={inviteUrl} className="font-mono text-xs" />
                        <CopyButton value={inviteUrl} label="Copy invite link" />
                      </div>
                    )}
                  </div>
                  <div className="space-y-3">
                    {draft.signers.map((signer, i) => (
                      <div key={signer.keyHash}>
                        <p className="text-sm font-medium text-zinc-300">
                          {GROUP_LABELS[signer.group]} {groupNumber(i)}
                        </p>
                        {signer.claimed ? (
                          <p className="break-all font-mono text-xs text-zinc-400">{signer.address}</p>
                        ) : (
                          <p className="text-xs text-zinc-500">Waiting</p>
                        )}
                      </div>
                    ))}
                  </div>
                  {!complete && (
                    <Field
                      label="Payment addresses"
                      hint="One per line, any order. Matched to script keys automatically."
                    >
                      <Textarea
                        aria-label="Payment addresses"
                        value={pasteAddresses}
                        rows={4}
                        disabled={busy}
                        spellCheck={false}
                        className="font-mono text-xs"
                        placeholder={"addr1…\naddr1…"}
                        onChange={(e) => setPasteAddresses(e.target.value)}
                      />
                      <Button
                        className="mt-2"
                        variant="secondary"
                        disabled={busy || !pasteAddresses.trim()}
                        loading={slot.busy}
                        onClick={() => void matchAddresses()}
                      >
                        Match addresses
                      </Button>
                    </Field>
                  )}
                  <ErrorText error={slot.error} />
                  <ErrorText error={save.error} />
                  {restoreId && <RestoreArchivedTreasury slug={slug} treasuryId={restoreId} />}
                  <Button onClick={() => void submit()} loading={save.busy}
                    disabled={busy || !complete || !!networkReason}>
                    Import treasury
                  </Button>
                </>
              )}
            </>
          )}
          <WarningText small>{networkReason}</WarningText>
        </Card>
      )}
    </div>
  );
}
