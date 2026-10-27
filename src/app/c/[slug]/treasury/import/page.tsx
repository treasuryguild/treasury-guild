"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api/client";
import type { CreateTreasuryResponse, TreasuryImportPreview } from "@/lib/api/types";
import { templateLabel } from "@/lib/cardano/spendingPaths";
import { describeThreshold } from "@/lib/cardano/thresholds";
import { asNetwork, networkName } from "@/lib/config";
import { SignerGroup, TreasuryTemplate } from "@/lib/constants";
import { formatDate } from "@/lib/format";
import { routes } from "@/lib/routes";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useCommunityGate } from "@/hooks/useCommunityGate";
import { useNetworkGate } from "@/hooks/useNetworkGate";
import { useWorkgroups } from "@/hooks/useWorkgroups";
import { COMMUNITY_TREASURY, TreasuryCreatedNotice, TreasuryLinkField } from "@/components/treasury/TreasuryWorkgroupLink";
import { Button, Card, CopyButton, ErrorText, Field, Input, LinkButton, PageTitle, Select, Textarea, WarningText } from "@/components/ui";

const GROUP_LABELS: Record<SignerGroup, string> = {
  [SignerGroup.Base]: "Signer",
  [SignerGroup.Recovery]: "Recovery signer",
  [SignerGroup.Cosigner]: "Co-signer",
};

export default function ImportTreasury({ params }: { params: Promise<{ slug: string }> }) {
  const { slug } = use(params);
  const router = useRouter();
  const { community, blocked } = useCommunityGate(slug, { require: "admin" });
  const { reason: networkReason } = useNetworkGate(community?.network);
  const workgroups = useWorkgroups(community?.id);
  const [name, setName] = useState("");
  const [cbor, setCbor] = useState("");
  const [preview, setPreview] = useState<TreasuryImportPreview | null>(null);
  const [signers, setSigners] = useState<{ keyHash: string; address: string; name: string; group: SignerGroup }[]>([]);
  const [workgroupId, setWorkgroupId] = useState(COMMUNITY_TREASURY);
  const [created, setCreated] = useState<CreateTreasuryResponse | null>(null);
  const review = useAsyncAction("Failed to read treasury CBOR");
  const save = useAsyncAction("Failed to import treasury");
  const busy = review.busy || save.busy;

  if (blocked) return blocked;

  async function readScript() {
    const result = await review.run(() => apiFetch<TreasuryImportPreview>("/api/treasury/import/preview", {
      body: { communityId: community!.id, source: { type: "cbor", cbor } },
    }));
    if (!result) return;
    setPreview(result);
    setSigners(result.signers.map((s) => ({ ...s, name: "" })));
  }

  async function submit() {
    if (!preview) return;
    const result = await save.run(() => apiFetch<CreateTreasuryResponse>("/api/treasury", {
      body: {
        communityId: community!.id,
        name: name.trim(),
        source: { type: "cbor", cbor: preview.scriptCbor },
        signers: signers.map((s) => ({ address: s.address.trim(), name: s.name.trim() })),
        workgroupId: workgroupId || null,
      },
    }));
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
            <Select aria-label="Import method" value="cbor" disabled>
              <option value="cbor">Native script CBOR</option>
            </Select>
          </Field>
          <Field label="Name">
            <Input aria-label="Name" value={name} disabled={busy}
              onChange={(e) => setName(e.target.value)} placeholder="Main treasury" />
          </Field>
          <Field label="Native script (CBOR hex)" hint="Paste the payment script: a flat all, any or at-least multisig, or one of Treasury Guild's clawback, lock-until or co-signer shapes.">
            <Textarea aria-label="Native script (CBOR hex)" value={cbor} rows={5} maxLength={65_536}
              disabled={busy} spellCheck={false} className="font-mono text-xs" placeholder="83030283…"
              onChange={(e) => {
                setCbor(e.target.value); setPreview(null); setSigners([]);
                review.setError(null); save.setError(null);
              }} />
          </Field>
          <ErrorText error={review.error} />
          <Button variant="secondary" onClick={() => void readScript()} loading={review.busy}
            disabled={busy || !cbor.trim()}>Read CBOR</Button>

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
                  Check this matches the treasury you want to import. CBOR contains no network or staking credential;
                  this imports an unstaked address on the community&apos;s network.
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
