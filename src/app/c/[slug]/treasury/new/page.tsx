"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api/client";
import type { CreateTreasuryResponse } from "@/lib/api/types";
import { templateLabel } from "@/lib/cardano/spendingPaths";
import { describeThreshold } from "@/lib/cardano/thresholds";
import { TreasuryTemplate } from "@/lib/constants";
import { routes } from "@/lib/routes";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useCommunityGate } from "@/hooks/useCommunityGate";
import { useCommunityMembers } from "@/hooks/useCommunityMembers";
import { useNetworkGate } from "@/hooks/useNetworkGate";
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
  const [name, setName] = useState("");
  const [signers, setSigners] = useState<SignerDraft[]>([
    emptySigner(),
    emptySigner(),
  ]);
  const [required, setRequired] = useState(2);
  const [draft, setDraft] = useState<TemplateDraft>(emptyTemplateDraft);
  const [confirming, setConfirming] = useState(false);
  const [workgroupId, setWorkgroupId] = useState(COMMUNITY_TREASURY);
  const [created, setCreated] = useState<CreateTreasuryResponse | null>(null);
  const workgroups = useWorkgroups(community?.id);
  const members = useCommunityMembers(community?.id);
  const { run, busy, error } = useAsyncAction("Failed to create treasury");
  // The creator must be a signer of the first treasury, and every signer
  // address must be on the community's network — so the wallet must be too.
  const { reason: networkReason } = useNetworkGate(community?.network);

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
  const plain = draft.template === TreasuryTemplate.Plain;

  function updateSigner(i: number, patch: Partial<SignerDraft>) {
    setSigners((prev) => prev.map((p, j) => (j === i ? { ...p, ...patch } : p)));
  }

  async function submit() {
    setConfirming(false);
    const result = await run(() =>
      apiFetch<CreateTreasuryResponse>("/api/treasury", {
        body: {
          communityId: community!.id,
          name,
          required,
          signers: filled.map((s) => ({
            address: s.address.trim(),
            name: s.name.trim(),
          })),
          workgroupId: workgroupId || null,
          ...templateRequest(draft),
        },
      }),
    );
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

        <Field label={plain ? "Signers (payment addresses)" : "Base signers (payment addresses)"}>
          <div className="space-y-2">
            {signers.map((s, i) => (
              <div key={i} className="flex flex-col gap-2 sm:flex-row">
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
            ))}
          </div>
          <Button
            variant="ghost"
            className="mt-2"
            onClick={() => setSigners((prev) => [...prev, emptySigner()])}
          >
            + Add signer
          </Button>
        </Field>

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
          disabled={busy}
        />

        <WarningText small>{networkReason}</WarningText>
        <ErrorText error={error} />
        <Button
          onClick={() => (plain ? void submit() : setConfirming(true))}
          disabled={!name || filled.length === 0 || !!networkReason || !templateComplete(draft)}
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
