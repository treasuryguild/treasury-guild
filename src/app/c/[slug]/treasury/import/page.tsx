"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, apiFetch } from "@/lib/api/client";
import type {
  Cip146LookupResponse,
  CreateTreasuryResponse,
  TreasuryImportPreview,
} from "@/lib/api/types";
import { paymentKeyHash } from "@/lib/cardano/multisigSDK";
import { templateLabel } from "@/lib/cardano/spendingPaths";
import { describeThreshold } from "@/lib/cardano/thresholds";
import { asNetwork, networkName } from "@/lib/config";
import { SignerGroup, TreasuryTemplate } from "@/lib/constants";
import { formatDate, shortHash } from "@/lib/format";
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

export default function ImportTreasury({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
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
  const [signers, setSigners] = useState<{ keyHash: string; address: string; name: string; group: SignerGroup }[]>([]);
  const [workgroupId, setWorkgroupId] = useState(COMMUNITY_TREASURY);
  const [created, setCreated] = useState<CreateTreasuryResponse | null>(null);
  const [restoreId, setRestoreId] = useState<string | null>(null);
  const review = useAsyncAction("Failed to read treasury");
  const discover = useAsyncAction("Failed to search on-chain registrations");
  const save = useAsyncAction("Failed to import treasury");
  const busy = review.busy || discover.busy || save.busy;

  if (blocked) return blocked;

  function clearPreview() {
    setPreview(null);
    setSigners([]);
    review.setError(null);
    save.setError(null);
  }

  function applyPreview(result: TreasuryImportPreview) {
    setPreview(result);
    setSigners(result.signers.map((s) => ({
      keyHash: s.keyHash,
      address: s.address,
      name: s.name,
      group: s.group,
    })));
    if (!name.trim() && result.suggestedName) setName(result.suggestedName);
  }

  async function readScript() {
    const result = await review.run(() => apiFetch<TreasuryImportPreview>("/api/treasury/import/preview", {
      body: { communityId: community!.id, source: { type: "cbor", cbor } },
    }));
    if (!result) return;
    applyPreview(result);
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
    applyPreview(result);
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

  async function submit() {
    if (!preview) return;
    setRestoreId(null);
    const result = await save.run(async () => {
      try {
        return await apiFetch<CreateTreasuryResponse>("/api/treasury", {
          body: {
            communityId: community!.id,
            name: name.trim(),
            source: {
              type: "cbor",
              cbor: preview.scriptCbor,
              ...(preview.stakeCredentialHash
                ? { stakeCredentialHash: preview.stakeCredentialHash }
                : {}),
            },
            signers: signers.map((s) => ({ address: s.address.trim(), name: s.name.trim() })),
            workgroupId: workgroupId || null,
          },
        });
      } catch (err) {
        if (err instanceof ApiError && err.body.restoreTreasuryId) setRestoreId(err.body.restoreTreasuryId);
        throw err;
      }
    });
    if (!result) return;
    if (workgroupId) setCreated(result);
    else router.push(routes.treasury(slug));
  }

  const baseCount = signers.filter((s) => s.group === SignerGroup.Base).length;
  const recoveryCount = signers.filter((s) => s.group === SignerGroup.Recovery).length;
  const groupNumber = (i: number) => signers.slice(0, i).filter((s) => s.group === signers[i]!.group).length + 1;

  return (
    <div className="mx-auto max-w-2xl">
      <PageTitle action={<LinkButton href={routes.treasury(slug)} variant="ghost">Back to treasury</LinkButton>}>
        Import treasury
      </PageTitle>
      {created ? (
        <TreasuryCreatedNotice slug={slug} result={created}
          workgroupName={workgroups.data?.find((w) => w.id === workgroupId)?.name ?? "the workgroup"} />
      ) : (
        <Card className="space-y-5">
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

          {preview && (
            <>
              <div className="space-y-2 rounded-lg border border-zinc-700 p-4">
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
              </div>
              <div className="space-y-4">
                <p className="text-sm text-zinc-400">
                  Match each key to its payment address. Known community wallets are filled in automatically.
                  Base signers of the community&apos;s first (primary) treasury become community admins; later
                  treasuries add them as members only. Recovery signers and a co-signer must already be members.
                  You must be a base signer of the first treasury.
                </p>
                {signers.map((signer, i) => (
                  <Field key={signer.keyHash} label={`${GROUP_LABELS[signer.group]} ${groupNumber(i)}`}>
                    <p className="mb-2 break-all font-mono text-xs text-zinc-500">{signer.keyHash}</p>
                    <div className="flex flex-col gap-2 sm:flex-row">
                      <Input aria-label={`${GROUP_LABELS[signer.group]} ${groupNumber(i)} address`} className="font-mono text-xs"
                        value={signer.address} disabled={busy} placeholder="Payment address"
                        onChange={(e) => setSigners((prev) => prev.map((s, j) => i === j ? { ...s, address: e.target.value } : s))} />
                      <Input aria-label={`${GROUP_LABELS[signer.group]} ${groupNumber(i)} name`} className="sm:max-w-32"
                        value={signer.name} disabled={busy} placeholder="Name (optional)"
                        onChange={(e) => setSigners((prev) => prev.map((s, j) => i === j ? { ...s, name: e.target.value } : s))} />
                    </div>
                  </Field>
                ))}
              </div>
              {!!workgroups.data?.length && <TreasuryLinkField workgroups={workgroups.data} value={workgroupId}
                disabled={busy} onChange={setWorkgroupId} />}
              <ErrorText error={save.error} />
              {restoreId && <RestoreArchivedTreasury slug={slug} treasuryId={restoreId} />}
              <Button onClick={() => void submit()} loading={save.busy}
                disabled={busy || !name.trim() || signers.some((s) => !s.address.trim()) || !!networkReason}>
                Import treasury
              </Button>
            </>
          )}
          <WarningText small>{networkReason}</WarningText>
        </Card>
      )}
    </div>
  );
}
