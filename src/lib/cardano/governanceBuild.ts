// Plan and persist stake / DRep / on-chain vote transactions for plain SDK
// treasuries. Session build routes and the agent API share these: plan runs
// every check (and, when publishing, pins metadata and builds the unsigned
// CBOR); persist stores the pending transaction (optional agent_draft_id for
// idempotent confirms). Agent previews call plan with `{ publish: false }` so
// they never write to public IPFS.
import "server-only";

import { sha256Hex } from "@/lib/auth/crypto";
import {
  DrepAction,
  SpendingPath,
  StakeAction,
  TxKind,
  type SpendingPath as SpendingPathT,
} from "@/lib/constants";
import { assertNoPendingTx, withTransactionRow } from "@/lib/db/transactions";
import { assertTreasuryActive } from "@/lib/db/treasuries";
import type { GovernanceAction, TransactionRow } from "@/lib/db/types";
import { BadRequestError, errorMessage } from "@/lib/errors";
import { canonicalJson } from "@/lib/governance/rules";
import { drepDescription, stakeDescription, voteDescription } from "@/lib/txDescription";
import { loadBuildContext, requirePathBuilder, resolveSpendingPath, type BuildContext } from "@/lib/tx";
import { buildDrepAnchorJson, buildDrepTx, pinDrepAnchor, type DrepAnchorInput } from "./drepBuilder";
import { isSpecialDrepId } from "./dreps";
import { fetchDrepStatus, fetchStakeAccountStatus, lookupDrep, lookupStakePool } from "./koios";
import { getProvider } from "./provider";
import { requireSdkDrep, requireSdkStake, requireSdkVote } from "./sdkTreasury";
import { buildStakeTx } from "./stakeBuilder";
import { buildVoteTx, pinVoteRationale } from "./voteBuilder";

/** Best-effort ticker for titles; never fails a build when Koios is down. */
async function resolvePoolTicker(
  network: BuildContext["network"],
  poolId: string | null,
): Promise<string | null> {
  if (!poolId) return null;
  try {
    const pool = await lookupStakePool(network, poolId);
    return pool?.ticker ?? null;
  } catch {
    return null;
  }
}

/** Best-effort CIP-119 givenName for titles; never fails a build when Koios is down. */
async function resolveDRepName(
  network: BuildContext["network"],
  dRepId: string | null,
): Promise<string | null> {
  if (!dRepId || isSpecialDrepId(dRepId)) return null;
  try {
    const drep = await lookupDrep(network, dRepId);
    return drep?.givenName ?? null;
  } catch {
    return null;
  }
}

export interface StakeInput {
  treasuryId: string;
  path?: SpendingPathT;
  action: StakeAction;
  poolId?: string | null;
  dRepId?: string | null;
}

export interface DrepInput extends DrepAnchorInput {
  treasuryId: string;
  path?: SpendingPathT;
  action: DrepAction;
}

export interface VoteBallot {
  txHash: string;
  certIndex: number;
  voteKind: "Yes" | "No" | "Abstain";
}

export interface VoteInput {
  treasuryId: string;
  path?: SpendingPathT;
  votes: VoteBallot[];
  rationaleJson?: Record<string, unknown>;
}

interface BuiltTx {
  unsignedTxHex: string;
  txHash: string;
}

export interface StakePlan {
  kind: "stake";
  treasuryId: string;
  ctx: BuildContext;
  path: typeof SpendingPath.Base;
  action: StakeAction;
  rewardAddress: string;
  poolId: string | null;
  dRepId: string | null;
  rewards: string | null;
  description: string;
  governanceAction: GovernanceAction;
  built: BuiltTx;
  fingerprint: string;
}

export interface DrepPlan {
  kind: "drep";
  treasuryId: string;
  ctx: BuildContext;
  path: typeof SpendingPath.Base;
  action: DrepAction;
  dRepId: string;
  anchorUrl: string | null;
  /** Content hash of the CIP-119 doc (fingerprint); null when retiring. */
  anchorContentHash: string | null;
  description: string;
  governanceAction: GovernanceAction;
  /** Null on a non-publishing preview (no CBOR until confirm). */
  built: BuiltTx | null;
  fingerprint: string;
}

export interface VotePlan {
  kind: "vote";
  treasuryId: string;
  ctx: BuildContext;
  path: typeof SpendingPath.Base;
  dRepId: string;
  votes: VoteBallot[];
  rationaleContentHash: string | null;
  description: string;
  governanceAction: GovernanceAction;
  /** Null on a non-publishing preview (no CBOR until confirm). */
  built: BuiltTx | null;
  fingerprint: string;
}

export type GovernancePlan = StakePlan | DrepPlan | VotePlan;

/** When false, prepare + hash only — no public IPFS write and no unsigned CBOR. */
export type PlanPublishOpts = { publish?: boolean };

function requireBasePath(
  ctx: BuildContext,
  requested: SpendingPathT | undefined,
  kind: typeof TxKind.Stake | typeof TxKind.Drep | typeof TxKind.Vote,
  label: string,
): typeof SpendingPath.Base {
  const path = resolveSpendingPath(ctx, requested, kind);
  if (path !== SpendingPath.Base) {
    throw new BadRequestError(`${label} use the base spending path only`);
  }
  return SpendingPath.Base;
}

export async function planStake(input: StakeInput, wallet: string): Promise<StakePlan> {
  const { treasuryId, action } = input;
  const ctx = await loadBuildContext(treasuryId, wallet);
  assertTreasuryActive(ctx.treasury);
  const path = requireBasePath(ctx, input.path, TxKind.Stake, "Stake actions");
  requirePathBuilder(ctx, path, "Only treasury signers can build a stake transaction");
  await assertNoPendingTx(treasuryId);

  const sdk = requireSdkStake(ctx.treasury, ctx.signers);
  const status = await fetchStakeAccountStatus(ctx.network, sdk.rewardAddress);

  if (
    (action === StakeAction.Register || action === StakeAction.RegisterAndDelegate) &&
    status.active
  ) {
    throw new BadRequestError("Stake key is already registered");
  }
  if (
    (action === StakeAction.Delegate ||
      action === StakeAction.Deregister ||
      action === StakeAction.Withdraw ||
      action === StakeAction.VoteDelegation) &&
    !status.active
  ) {
    throw new BadRequestError("Stake key is not registered yet — register first");
  }
  if (action === StakeAction.Withdraw && (!status.rewardsAvailable || status.rewardsAvailable === "0")) {
    throw new BadRequestError("No rewards available to withdraw");
  }

  const poolId = input.poolId ?? null;
  const dRepId = input.dRepId ?? null;
  const [poolTicker, dRepName, built] = await Promise.all([
    resolvePoolTicker(ctx.network, poolId),
    action === StakeAction.VoteDelegation
      ? resolveDRepName(ctx.network, dRepId)
      : Promise.resolve(null),
    (async (): Promise<BuiltTx> => {
      try {
        return await buildStakeTx({
          treasuryAddress: sdk.address,
          paymentScriptCbor: sdk.paymentScriptCbor,
          stakingScriptCbor: sdk.stakingScriptCbor,
          rewardAddress: sdk.rewardAddress,
          network: ctx.network,
          provider: getProvider(ctx.network),
          action,
          poolId,
          dRepId,
          rewards: status.rewardsAvailable,
        });
      } catch (err) {
        throw new BadRequestError(errorMessage(err));
      }
    })(),
  ]);

  const rewards = action === StakeAction.Withdraw ? status.rewardsAvailable : null;
  const governanceAction: GovernanceAction = {
    kind: "stake",
    action,
    poolId,
    poolTicker,
    dRepId,
    dRepName,
    rewards,
  };
  return {
    kind: "stake",
    treasuryId,
    ctx,
    path,
    action,
    rewardAddress: sdk.rewardAddress,
    poolId,
    dRepId,
    rewards,
    description: stakeDescription(action, { poolId, poolTicker, dRepId, dRepName }),
    governanceAction,
    built,
    fingerprint: sha256Hex(canonicalJson({
      treasuryId,
      action,
      poolId,
      dRepId,
      rewards,
      rewardAddress: sdk.rewardAddress,
    })),
  };
}

export async function planDrep(
  input: DrepInput,
  wallet: string,
  opts: PlanPublishOpts = {},
): Promise<DrepPlan> {
  const publish = opts.publish !== false;
  const { treasuryId, action } = input;
  const ctx = await loadBuildContext(treasuryId, wallet);
  assertTreasuryActive(ctx.treasury);
  const path = requireBasePath(ctx, input.path, TxKind.Drep, "DRep actions");
  requirePathBuilder(ctx, path, "Only treasury signers can build a DRep transaction");
  await assertNoPendingTx(treasuryId);

  const sdk = requireSdkDrep(ctx.treasury, ctx.signers);
  const status = await fetchDrepStatus(ctx.network, sdk.dRepId);

  if (action === DrepAction.Register && status.active) {
    throw new BadRequestError("This DRep is already registered");
  }
  if ((action === DrepAction.Update || action === DrepAction.Retire) && !status.active) {
    throw new BadRequestError("This DRep is not registered yet");
  }

  let anchor: { anchorUrl: string; anchorDataHash: string } | null = null;
  let anchorContentHash: string | null = null;
  if (action === DrepAction.Register || action === DrepAction.Update) {
    try {
      const doc = buildDrepAnchorJson(input);
      anchorContentHash = sha256Hex(canonicalJson(doc));
      if (publish) anchor = await pinDrepAnchor(doc);
    } catch (err) {
      throw new BadRequestError(errorMessage(err));
    }
  }

  let built: BuiltTx | null = null;
  if (publish) {
    try {
      built = await buildDrepTx({
        treasuryAddress: sdk.address,
        paymentScriptCbor: sdk.paymentScriptCbor,
        drepScriptCbor: sdk.drepScriptCbor,
        dRepId: sdk.dRepId,
        network: ctx.network,
        provider: getProvider(ctx.network),
        action,
        anchor,
      });
    } catch (err) {
      throw new BadRequestError(errorMessage(err));
    }
  }

  const governanceAction: GovernanceAction = {
    kind: "drep",
    action,
    dRepId: sdk.dRepId,
    anchorUrl: anchor?.anchorUrl ?? null,
  };
  return {
    kind: "drep",
    treasuryId,
    ctx,
    path,
    action,
    dRepId: sdk.dRepId,
    anchorUrl: anchor?.anchorUrl ?? null,
    anchorContentHash,
    description: drepDescription(action, sdk.dRepId),
    governanceAction,
    built,
    fingerprint: sha256Hex(canonicalJson({
      treasuryId,
      action,
      dRepId: sdk.dRepId,
      anchorContentHash,
    })),
  };
}

export async function planVote(
  input: VoteInput,
  wallet: string,
  opts: PlanPublishOpts = {},
): Promise<VotePlan> {
  const publish = opts.publish !== false;
  const { treasuryId, votes } = input;
  const ctx = await loadBuildContext(treasuryId, wallet);
  assertTreasuryActive(ctx.treasury);
  const path = requireBasePath(ctx, input.path, TxKind.Vote, "Votes");
  requirePathBuilder(ctx, path, "Only treasury signers can build a vote transaction");
  await assertNoPendingTx(treasuryId);

  const sdk = requireSdkVote(ctx.treasury, ctx.signers);
  const status = await fetchDrepStatus(ctx.network, sdk.dRepId);
  if (!status.active) {
    throw new BadRequestError("Register as a DRep before casting on-chain votes");
  }

  let rationale: { anchorUrl: string; anchorDataHash: string } | null = null;
  let rationaleContentHash: string | null = null;
  if (input.rationaleJson) {
    try {
      rationaleContentHash = sha256Hex(canonicalJson(input.rationaleJson));
      if (publish) rationale = await pinVoteRationale(input.rationaleJson);
    } catch (err) {
      throw new BadRequestError(errorMessage(err));
    }
  }

  let built: BuiltTx | null = null;
  if (publish) {
    try {
      built = await buildVoteTx({
        treasuryAddress: sdk.address,
        paymentScriptCbor: sdk.paymentScriptCbor,
        drepScriptCbor: sdk.drepScriptCbor,
        dRepId: sdk.dRepId,
        network: ctx.network,
        provider: getProvider(ctx.network),
        votes,
        rationale,
      });
    } catch (err) {
      throw new BadRequestError(errorMessage(err));
    }
  }

  const sortedVotes = [...votes]
    .map((v) => ({ txHash: v.txHash, certIndex: v.certIndex, voteKind: v.voteKind }))
    .sort((a, b) => a.txHash.localeCompare(b.txHash) || a.certIndex - b.certIndex);
  const governanceAction: GovernanceAction = {
    kind: "vote",
    dRepId: sdk.dRepId,
    votes: sortedVotes,
  };
  return {
    kind: "vote",
    treasuryId,
    ctx,
    path,
    dRepId: sdk.dRepId,
    votes: sortedVotes,
    rationaleContentHash,
    description: voteDescription(votes.length, sdk.dRepId),
    governanceAction,
    built,
    fingerprint: sha256Hex(canonicalJson({
      treasuryId,
      dRepId: sdk.dRepId,
      votes: sortedVotes,
      rationaleContentHash,
    })),
  };
}

export async function persistGovernanceTx(
  plan: GovernancePlan,
  wallet: string,
  opts: { agentDraftId?: string } = {},
): Promise<TransactionRow> {
  if (!plan.built) {
    throw new BadRequestError("Confirm the draft again: the transaction was not built for publication");
  }
  const kind =
    plan.kind === "stake" ? TxKind.Stake : plan.kind === "drep" ? TxKind.Drep : TxKind.Vote;
  return withTransactionRow(
    {
      treasury_id: plan.treasuryId,
      kind,
      spending_path: plan.path,
      tx_cbor: plan.built.unsignedTxHex,
      tx_hash: plan.built.txHash,
      description: plan.description,
      created_by: wallet,
      governance_action: plan.governanceAction,
      ...(opts.agentDraftId ? { agent_draft_id: opts.agentDraftId } : {}),
    },
    async (tx) => tx,
  );
}
