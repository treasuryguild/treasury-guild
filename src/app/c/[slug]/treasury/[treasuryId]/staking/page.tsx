"use client";

import { use, useState } from "react";
import { useRouter } from "next/navigation";
import { apiFetch } from "@/lib/api/client";
import type {
  BuildStakeResponse,
  StakeAccountResponse,
  TreasuryDetailsResponse,
} from "@/lib/api/types";
import { StakeAction } from "@/lib/constants";
import { formatLovelace, shortAddress } from "@/lib/format";
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
} from "@/components/ui";

export default function TreasuryStakingPage({
  params,
}: {
  params: Promise<{ slug: string; treasuryId: string }>;
}) {
  const { slug, treasuryId } = use(params);
  const router = useRouter();
  const { community, blocked } = useCommunityGate(slug);
  const [action, setAction] = useState<StakeAction>(StakeAction.RegisterAndDelegate);
  const [poolId, setPoolId] = useState("");
  const [dRepId, setDRepId] = useState("always_abstain");
  const { run, busy, error } = useAsyncAction("Failed to build stake transaction");

  const details = useAsyncData(
    community ? `treasury:${treasuryId}` : null,
    async () => apiFetch<TreasuryDetailsResponse>(`/api/treasury?treasuryId=${treasuryId}`),
  );
  const account = useAsyncData(
    details.data?.treasury.canStake ? `stake:${treasuryId}` : null,
    async () => apiFetch<StakeAccountResponse>(`/api/chain/stake-account?treasuryId=${treasuryId}`),
  );

  if (blocked) return blocked;

  const treasury = details.data?.treasury;
  if (details.error) return <ErrorText error={details.error} />;
  if (!treasury) return <p className="text-sm text-zinc-500">Loading…</p>;

  if (!treasury.canStake) {
    return (
      <div className="mx-auto max-w-2xl space-y-4">
        <PageTitle>Staking — {treasury.name}</PageTitle>
        <Card className="space-y-3">
          <p className="text-sm">
            This treasury cannot stake. Only a <strong>plain SDK</strong> wallet (stake keys for every base signer) can register and delegate.
            Legacy and templated treasuries stay spend-only — create a new plain SDK treasury and move funds.
          </p>
          <LinkButton href={routes.newTreasury(slug)}>New treasury</LinkButton>
        </Card>
      </div>
    );
  }

  const status = account.data;

  async function build() {
    const result = await run(() =>
      apiFetch<BuildStakeResponse>("/api/tx/build-stake", {
        body: {
          treasuryId,
          action,
          ...(action === StakeAction.Delegate || action === StakeAction.RegisterAndDelegate
            ? { poolId: poolId.trim() }
            : {}),
          ...(action === StakeAction.VoteDelegation ? { dRepId: dRepId.trim() } : {}),
        },
      }),
    );
    if (result) router.push(routes.tx(slug, result.txId));
  }

  const needsPool =
    action === StakeAction.Delegate || action === StakeAction.RegisterAndDelegate;

  return (
    <div className="mx-auto max-w-2xl space-y-4">
      <PageTitle>Staking — {treasury.name}</PageTitle>
      <Card className="space-y-4">
        <p className="text-sm text-zinc-600">
          Reward address{" "}
          <code className="text-xs">{shortAddress(treasury.stakeAddress ?? "")}</code>
        </p>
        {account.error && <ErrorText error={account.error} />}
        {status && (
          <dl className="grid grid-cols-2 gap-2 text-sm">
            <dt className="text-zinc-500">Status</dt>
            <dd>{status.active ? "Registered" : "Not registered"}</dd>
            <dt className="text-zinc-500">Pool</dt>
            <dd className="font-mono text-xs">{status.poolId ?? "—"}</dd>
            <dt className="text-zinc-500">Vote delegation</dt>
            <dd className="font-mono text-xs">{status.dRepId ?? "—"}</dd>
            <dt className="text-zinc-500">Rewards</dt>
            <dd>{formatLovelace(BigInt(status.rewardsAvailable || "0"))} ADA</dd>
          </dl>
        )}

        <Field label="Action">
          <Select
            value={action}
            disabled={busy}
            onChange={(e) => setAction(e.target.value as StakeAction)}
          >
            <option value={StakeAction.RegisterAndDelegate}>Register and delegate</option>
            <option value={StakeAction.Register}>Register only</option>
            <option value={StakeAction.Delegate}>Delegate</option>
            <option value={StakeAction.Deregister}>Deregister</option>
            <option value={StakeAction.Withdraw}>Withdraw rewards</option>
            <option value={StakeAction.VoteDelegation}>Vote delegation (DRep)</option>
          </Select>
        </Field>

        {needsPool && (
          <Field label="Pool id" hint="pool1… or 56-character hex">
            <Input
              className="font-mono text-xs"
              value={poolId}
              onChange={(e) => setPoolId(e.target.value)}
              placeholder="pool1…"
              disabled={busy}
            />
          </Field>
        )}

        {action === StakeAction.VoteDelegation && (
          <Field label="DRep">
            <Select value={dRepId} disabled={busy} onChange={(e) => setDRepId(e.target.value)}>
              <option value="always_abstain">Always abstain</option>
              <option value="always_no_confidence">Always no confidence</option>
            </Select>
            <Input
              className="mt-2 font-mono text-xs"
              value={dRepId.startsWith("always_") ? "" : dRepId}
              onChange={(e) => setDRepId(e.target.value.trim() || "always_abstain")}
              placeholder="Or paste a drep1… id"
              disabled={busy}
            />
          </Field>
        )}

        <ErrorText error={error} />
        <Button
          onClick={() => void build()}
          loading={busy}
          disabled={needsPool && !poolId.trim()}
        >
          Build transaction
        </Button>
        <p className="text-xs text-zinc-500">
          Signers must witness with both their payment and stake keys. The transaction waits on the
          normal signing page.
        </p>
      </Card>
    </div>
  );
}
