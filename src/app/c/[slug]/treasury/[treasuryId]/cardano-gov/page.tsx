"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api/client";
import type {
  BuildDrepResponse,
  BuildVoteResponse,
  ChainProposalsResponse,
  DrepStatusResponse,
  TreasuryDetailsResponse,
} from "@/lib/api/types";
import { DrepAction } from "@/lib/constants";
import { shortHash } from "@/lib/format";
import { routes } from "@/lib/routes";
import { useAsyncAction } from "@/hooks/useAsyncAction";
import { useAsyncData } from "@/hooks/useAsyncData";
import { useCommunityGate } from "@/hooks/useCommunityGate";
import {
  Button,
  Card,
  ErrorText,
  Field,
  Input,
  LinkButton,
  PageTitle,
  Select,
  SectionTitle,
} from "@/components/ui";
import Link from "next/link";

type VoteKind = "Yes" | "No" | "Abstain";

export default function TreasuryCardanoGovPage({
  params,
}: {
  params: Promise<{ slug: string; treasuryId: string }>;
}) {
  const { slug, treasuryId } = use(params);
  const router = useRouter();
  const { community, blocked } = useCommunityGate(slug);
  const [drepAction, setDrepAction] = useState<DrepAction>(DrepAction.Register);
  const [givenName, setGivenName] = useState("");
  const [motivations, setMotivations] = useState("");
  const [voteKind, setVoteKind] = useState<VoteKind>("Yes");
  const [selected, setSelected] = useState<{ txHash: string; certIndex: number } | null>(null);
  const drepBuild = useAsyncAction("Failed to build DRep transaction");
  const voteBuild = useAsyncAction("Failed to build vote");

  const details = useAsyncData(
    community ? `treasury:${treasuryId}` : null,
    async () => apiFetch<TreasuryDetailsResponse>(`/api/treasury?treasuryId=${treasuryId}`),
  );
  const drep = useAsyncData(
    details.data?.treasury.canDrep ? `drep:${treasuryId}` : null,
    async () => apiFetch<DrepStatusResponse>(`/api/chain/drep?treasuryId=${treasuryId}`),
  );
  const proposals = useAsyncData(
    details.data?.treasury.canDrep && drep.data?.active ? `props:${treasuryId}` : null,
    async () => apiFetch<ChainProposalsResponse>(`/api/chain/proposals?treasuryId=${treasuryId}`),
  );

  if (blocked) return blocked;

  const treasury = details.data?.treasury;
  if (details.error) return <ErrorText error={details.error} />;
  if (!treasury) return <p className="text-sm text-zinc-500">Loading…</p>;

  if (!treasury.canDrep) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <PageTitle>Cardano governance — {treasury.name}</PageTitle>
        <Card className="space-y-3">
          <p className="text-sm">
            This treasury cannot act as a DRep or cast on-chain votes. Only a <strong>plain SDK</strong> wallet
            supports Cardano governance. Community proposals under Proposals are a separate, off-chain vote.
          </p>
          <LinkButton href={routes.newTreasury(slug)}>New treasury</LinkButton>
        </Card>
      </div>
    );
  }

  async function buildDrep() {
    const result = await drepBuild.run(() =>
      apiFetch<BuildDrepResponse>("/api/tx/build-drep", {
        body: {
          treasuryId,
          action: drepAction,
          ...(drepAction !== DrepAction.Retire
            ? { givenName: givenName.trim(), motivations: motivations.trim() || undefined }
            : {}),
        },
      }),
    );
    if (result) router.push(routes.tx(slug, result.txId));
  }

  async function buildVote() {
    if (!selected) return;
    const result = await voteBuild.run(() =>
      apiFetch<BuildVoteResponse>("/api/tx/build-vote", {
        body: {
          treasuryId,
          votes: [{ ...selected, voteKind }],
        },
      }),
    );
    if (result) router.push(routes.tx(slug, result.txId));
  }

  return (
    <div className="mx-auto max-w-2xl space-y-6">
      <PageTitle>Cardano governance — {treasury.name}</PageTitle>
      <p className="text-sm text-zinc-600">
        On-chain DRep identity and votes for this multisig. This is not the community&apos;s{" "}
        <Link href={routes.proposals(slug)} className="text-indigo-400 hover:underline">
          Proposals
        </Link>{" "}
        page.
      </p>

      <Card className="space-y-4">
        <SectionTitle>DRep</SectionTitle>
        <p className="font-mono text-xs break-all">{treasury.dRepId}</p>
        {drep.error && <ErrorText error={drep.error} />}
        {drep.data && (
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt className="text-zinc-500">Status</dt>
            <dd>{drep.data.active ? "Registered" : "Not registered"}</dd>
            <dt className="text-zinc-500">Voting power</dt>
            <dd>{drep.data.votingPower ?? "—"}</dd>
          </dl>
        )}

        <Field label="Action">
          <Select
            value={drepAction}
            disabled={drepBuild.busy}
            onChange={(e) => setDrepAction(e.target.value as DrepAction)}
          >
            <option value={DrepAction.Register}>Register</option>
            <option value={DrepAction.Update}>Update metadata</option>
            <option value={DrepAction.Retire}>Retire</option>
          </Select>
        </Field>
        {drepAction !== DrepAction.Retire && (
          <>
            <Field label="Given name">
              <Input value={givenName} onChange={(e) => setGivenName(e.target.value)} disabled={drepBuild.busy} />
            </Field>
            <Field label="Motivations (optional)">
              <Input value={motivations} onChange={(e) => setMotivations(e.target.value)} disabled={drepBuild.busy} />
            </Field>
          </>
        )}
        <ErrorText error={drepBuild.error} />
        <Button
          onClick={() => void buildDrep()}
          loading={drepBuild.busy}
          disabled={drepAction !== DrepAction.Retire && !givenName.trim()}
        >
          Build DRep transaction
        </Button>
      </Card>

      <Card className="space-y-4">
        <SectionTitle>Vote on a proposal</SectionTitle>
        {!drep.data?.active ? (
          <p className="text-sm text-zinc-500">Register as a DRep first to cast on-chain votes.</p>
        ) : (
          <>
            {proposals.error && <ErrorText error={proposals.error} />}
            <Field label="Active proposal">
              <Select
                value={selected ? `${selected.txHash}:${selected.certIndex}` : ""}
                disabled={voteBuild.busy}
                onChange={(e) => {
                  const [txHash, idx] = e.target.value.split(":");
                  if (!txHash) {
                    setSelected(null);
                    return;
                  }
                  setSelected({ txHash, certIndex: Number(idx) });
                }}
              >
                <option value="">Choose…</option>
                {(proposals.data?.proposals ?? []).map((p) => (
                  <option key={`${p.txHash}:${p.certIndex}`} value={`${p.txHash}:${p.certIndex}`}>
                    {(p.title || p.type || shortHash(p.txHash)).slice(0, 80)}
                  </option>
                ))}
              </Select>
            </Field>
            <Field label="Vote">
              <Select
                value={voteKind}
                disabled={voteBuild.busy}
                onChange={(e) => setVoteKind(e.target.value as VoteKind)}
              >
                <option value="Yes">Yes</option>
                <option value="No">No</option>
                <option value="Abstain">Abstain</option>
              </Select>
            </Field>
            <ErrorText error={voteBuild.error} />
            <Button onClick={() => void buildVote()} loading={voteBuild.busy} disabled={!selected}>
              Build vote transaction
            </Button>
          </>
        )}
      </Card>
    </div>
  );
}
