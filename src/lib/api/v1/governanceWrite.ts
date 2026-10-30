// Stake / DRep / on-chain vote drafts through the agent API. Each *_preview
// runs the same checks as the session build routes (planStake / planDrep /
// planVote) without public IPFS writes, and returns a draft token;
// draft_confirm re-plans with publication, then stores the pending transaction
// keyed by the draft (transactions.agent_draft_id). Signers still sign in the
// app; no tool signs or submits.
import "server-only";

import { z } from "zod";
import type { ApiCaller } from "@/lib/api/caller";
import type {
  V1DraftPreview,
  V1GovernanceTxCreateResponse,
} from "@/lib/api/types";
import { pathLabel, pathRule } from "@/lib/cardano/spendingPaths";
import { requiredSignatures } from "@/lib/cardano/thresholds";
import {
  persistGovernanceTx,
  planDrep,
  planStake,
  planVote,
  type DrepPlan,
  type StakePlan,
  type VotePlan,
} from "@/lib/cardano/governanceBuild";
import { DrepAction, StakeAction } from "@/lib/constants";
import { findTransactionByDraft, type DraftTransaction } from "@/lib/db/transactions";
import { ARCHIVED_TREASURY_BUILD, listCommunityTreasuries } from "@/lib/db/treasuries";
import { BadRequestError, ConflictError } from "@/lib/errors";
import { mintDraftToken, type VerifiedDraft } from "@/lib/mcp/draftToken";
import { routes } from "@/lib/routes";
import { defineEndpoint } from "./endpoint";
import { CONFIRM_NEXT } from "./shape";
import { appLink, communityInput, memberCommunity, resolveCommunityTreasury } from "./shared";

const treasuryRef = z.string().trim().min(1).max(200)
  .describe("The treasury: name or id. Must be a plain SDK wallet the caller signs for.");

const stakeAction = z.enum([
  StakeAction.Register,
  StakeAction.RegisterAndDelegate,
  StakeAction.Delegate,
  StakeAction.Deregister,
  StakeAction.Withdraw,
  StakeAction.VoteDelegation,
]);

const drepAction = z.enum([DrepAction.Register, DrepAction.Update, DrepAction.Retire]);

function governanceAnswer(
  community: { slug: string; name: string },
  treasuryName: string,
  created: boolean,
  tx: Pick<DraftTransaction, "id" | "tx_hash" | "spending_path">,
  plan: StakePlan | DrepPlan | VotePlan,
): V1GovernanceTxCreateResponse {
  const rule = pathRule(plan.ctx.treasury, plan.ctx.signers, tx.spending_path);
  return {
    community: { slug: community.slug, name: community.name },
    created,
    txId: tx.id,
    txHash: tx.tx_hash,
    treasury: treasuryName,
    requiredSignatures: requiredSignatures(rule),
    url: appLink(routes.tx(community.slug, tx.id)),
  };
}

async function confirmGovernance(
  caller: ApiCaller,
  draft: VerifiedDraft,
  replan: (treasuryId: string, request: Record<string, unknown>) => Promise<StakePlan | DrepPlan | VotePlan>,
  mismatchMessage: string,
): Promise<V1GovernanceTxCreateResponse> {
  const { community } = await memberCommunity(caller, draft.community);
  const treasuryId = typeof draft.request.treasuryId === "string" ? draft.request.treasuryId : "";
  const treasuries = await listCommunityTreasuries(community.id);
  const treasury = treasuries.find((t) => t.id === treasuryId);
  if (!treasury) throw new BadRequestError("This draft is not valid: preview it again");

  const existing = await findTransactionByDraft(draft.draftId);
  if (existing) {
    // Re-plan is skipped; use a minimal path rule from the stored treasury row.
    const rule = pathRule(treasury, treasury.treasury_signers, existing.spending_path);
    return {
      community: { slug: community.slug, name: community.name },
      created: false,
      txId: existing.id,
      txHash: existing.tx_hash,
      treasury: treasury.name,
      requiredSignatures: requiredSignatures(rule),
      url: appLink(routes.tx(community.slug, existing.id)),
    };
  }

  const plan = await replan(treasuryId, draft.request);
  if (plan.fingerprint !== draft.fingerprint) {
    throw new ConflictError(mismatchMessage);
  }
  try {
    return governanceAnswer(
      community,
      treasury.name,
      true,
      await persistGovernanceTx(plan, caller.wallet, { agentDraftId: draft.draftId }),
      plan,
    );
  } catch (err) {
    const raced = err instanceof ConflictError ? await findTransactionByDraft(draft.draftId) : null;
    if (raced) return governanceAnswer(community, treasury.name, false, raced, plan);
    throw err;
  }
}

export const previewStake = defineEndpoint({
  scope: "governance:write",
  input: z.object({
    community: communityInput,
    treasury: treasuryRef,
    action: stakeAction.describe("register, register_and_delegate, delegate, deregister, withdraw, or vote_delegation"),
    poolId: z.string().min(1).max(120).optional()
      .describe("Stake pool bech32 (pool1…) or 56-char hex; required for delegate / register_and_delegate"),
    dRepId: z.string().min(1).max(120).optional()
      .describe("DRep id, always_abstain, or always_no_confidence; required for vote_delegation"),
  }).superRefine((body, ctx) => {
    if (
      (body.action === StakeAction.Delegate || body.action === StakeAction.RegisterAndDelegate) &&
      !body.poolId
    ) {
      ctx.addIssue({ code: "custom", path: ["poolId"], message: "Choose a stake pool" });
    }
    if (body.action === StakeAction.VoteDelegation && !body.dRepId) {
      ctx.addIssue({ code: "custom", path: ["dRepId"], message: "Choose a DRep or always abstain / no confidence" });
    }
  }),
  async run(caller, input): Promise<V1DraftPreview> {
    const { community } = await memberCommunity(caller, input.community);
    const treasury = await resolveCommunityTreasury(community.id, input.treasury);
    if (treasury.archived_at) throw new ConflictError(ARCHIVED_TREASURY_BUILD);

    const request = {
      treasuryId: treasury.id,
      action: input.action,
      poolId: input.poolId ?? null,
      dRepId: input.dRepId ?? null,
    };
    const plan = await planStake(
      {
        treasuryId: treasury.id,
        action: input.action,
        poolId: input.poolId,
        dRepId: input.dRepId,
      },
      caller.wallet,
    );
    const { token, expiresAt } = await mintDraftToken(caller, {
      action: "stake_create",
      community: community.slug,
      request,
      fingerprint: plan.fingerprint,
      rulesHash: "",
    });
    const rule = pathRule(plan.ctx.treasury, plan.ctx.signers, plan.path);
    return {
      community: { slug: community.slug, name: community.name },
      action: "stake_create",
      summary: plan.description,
      details: {
        treasury: treasury.name,
        spendingPath: pathLabel(plan.path),
        requiredSignatures: requiredSignatures(rule),
        action: plan.action,
        rewardAddress: plan.rewardAddress,
        poolId: plan.poolId,
        dRepId: plan.dRepId,
        rewards: plan.rewards,
      },
      effects: [
        `It becomes ${treasury.name}'s pending transaction: no other payout, payment, stake, DRep or vote can be built from that treasury until it is signed and submitted, or rejected.`,
        `Nothing reaches the chain until ${requiredSignatures(rule)} signer${requiredSignatures(rule) === 1 ? "" : "s"} sign it in the app with payment and stake keys.`,
      ],
      next: CONFIRM_NEXT,
      draftToken: token,
      expiresAt,
    };
  },
});

export const previewDrep = defineEndpoint({
  scope: "governance:write",
  input: z.object({
    community: communityInput,
    treasury: treasuryRef,
    action: drepAction.describe("register, update, or retire"),
    anchorJson: z.record(z.string(), z.unknown()).optional()
      .describe("Full CIP-119 metadata object; hashed on preview, pinned publicly on confirm"),
    givenName: z.string().trim().min(1).max(100).optional()
      .describe("Display name for a minimal CIP-119 document when anchorJson is omitted"),
    motivations: z.string().max(2000).optional(),
    objectives: z.string().max(2000).optional(),
    qualifications: z.string().max(2000).optional(),
    imageUrl: z.string().url().max(500).optional(),
  }).superRefine((body, ctx) => {
    if (body.action === DrepAction.Retire) return;
    if (!body.anchorJson && !body.givenName) {
      ctx.addIssue({
        code: "custom",
        path: ["givenName"],
        message: "Provide DRep metadata (given name) or an anchor JSON document",
      });
    }
  }),
  async run(caller, input): Promise<V1DraftPreview> {
    const { community } = await memberCommunity(caller, input.community);
    const treasury = await resolveCommunityTreasury(community.id, input.treasury);
    if (treasury.archived_at) throw new ConflictError(ARCHIVED_TREASURY_BUILD);

    const request = {
      treasuryId: treasury.id,
      action: input.action,
      anchorJson: input.anchorJson ?? null,
      givenName: input.givenName ?? null,
      motivations: input.motivations ?? null,
      objectives: input.objectives ?? null,
      qualifications: input.qualifications ?? null,
      imageUrl: input.imageUrl ?? null,
    };
    const plan = await planDrep(
      {
        treasuryId: treasury.id,
        action: input.action,
        anchorJson: input.anchorJson,
        givenName: input.givenName,
        motivations: input.motivations,
        objectives: input.objectives,
        qualifications: input.qualifications,
        imageUrl: input.imageUrl,
      },
      caller.wallet,
      { publish: false },
    );
    const { token, expiresAt } = await mintDraftToken(caller, {
      action: "drep_create",
      community: community.slug,
      request,
      fingerprint: plan.fingerprint,
      rulesHash: "",
    });
    const rule = pathRule(plan.ctx.treasury, plan.ctx.signers, plan.path);
    const publishesMetadata = input.action === DrepAction.Register || input.action === DrepAction.Update;
    return {
      community: { slug: community.slug, name: community.name },
      action: "drep_create",
      summary: plan.description,
      details: {
        treasury: treasury.name,
        spendingPath: pathLabel(plan.path),
        requiredSignatures: requiredSignatures(rule),
        action: plan.action,
        dRepId: plan.dRepId,
        anchorContentHash: plan.anchorContentHash,
      },
      effects: [
        `It becomes ${treasury.name}'s pending transaction until signed and submitted, or rejected.`,
        `Nothing reaches the chain until ${requiredSignatures(rule)} signer${requiredSignatures(rule) === 1 ? "" : "s"} sign it in the app.`,
        "This is Cardano DRep registration, not a community proposal vote.",
        ...(publishesMetadata
          ? ["Confirming publishes the DRep metadata to public IPFS; abandoning this preview does not."]
          : []),
      ],
      next: CONFIRM_NEXT,
      draftToken: token,
      expiresAt,
    };
  },
});

export const previewVote = defineEndpoint({
  scope: "governance:write",
  input: z.object({
    community: communityInput,
    treasury: treasuryRef,
    votes: z.array(z.object({
      txHash: z.string().regex(/^[0-9a-fA-F]{64}$/, "Transaction hash must be 64 hex characters"),
      certIndex: z.number().int().min(0).max(10_000),
      voteKind: z.enum(["Yes", "No", "Abstain"]),
    })).min(1).max(50)
      .describe("One or more Cardano governance proposal votes"),
    rationaleJson: z.record(z.string(), z.unknown()).optional()
      .describe("Optional CIP-100 rationale JSON; hashed on preview, pinned publicly on confirm"),
  }),
  async run(caller, input): Promise<V1DraftPreview> {
    const { community } = await memberCommunity(caller, input.community);
    const treasury = await resolveCommunityTreasury(community.id, input.treasury);
    if (treasury.archived_at) throw new ConflictError(ARCHIVED_TREASURY_BUILD);

    const request = {
      treasuryId: treasury.id,
      votes: input.votes,
      rationaleJson: input.rationaleJson ?? null,
    };
    const plan = await planVote(
      {
        treasuryId: treasury.id,
        votes: input.votes,
        rationaleJson: input.rationaleJson,
      },
      caller.wallet,
      { publish: false },
    );
    const { token, expiresAt } = await mintDraftToken(caller, {
      action: "vote_create",
      community: community.slug,
      request,
      fingerprint: plan.fingerprint,
      rulesHash: "",
    });
    const rule = pathRule(plan.ctx.treasury, plan.ctx.signers, plan.path);
    return {
      community: { slug: community.slug, name: community.name },
      action: "vote_create",
      summary: plan.description,
      details: {
        treasury: treasury.name,
        spendingPath: pathLabel(plan.path),
        requiredSignatures: requiredSignatures(rule),
        dRepId: plan.dRepId,
        votes: plan.votes,
        rationaleContentHash: plan.rationaleContentHash,
      },
      effects: [
        `It becomes ${treasury.name}'s pending transaction until signed and submitted, or rejected.`,
        `Nothing reaches the chain until ${requiredSignatures(rule)} signer${requiredSignatures(rule) === 1 ? "" : "s"} sign it in the app.`,
        "This is an on-chain Cardano governance vote, not a community proposal ballot.",
        ...(input.rationaleJson
          ? ["Confirming publishes the vote rationale to public IPFS; abandoning this preview does not."]
          : []),
      ],
      next: CONFIRM_NEXT,
      draftToken: token,
      expiresAt,
    };
  },
});

export async function confirmStake(caller: ApiCaller, draft: VerifiedDraft): Promise<V1GovernanceTxCreateResponse> {
  return confirmGovernance(
    caller,
    draft,
    async (treasuryId, request) => {
      const action = request.action;
      if (typeof action !== "string") throw new BadRequestError("This draft is not valid: preview it again");
      return planStake(
        {
          treasuryId,
          action: action as StakeAction,
          poolId: typeof request.poolId === "string" ? request.poolId : null,
          dRepId: typeof request.dRepId === "string" ? request.dRepId : null,
        },
        caller.wallet,
      );
    },
    "The stake action changed since the preview (registration state, pool, rewards or DRep). Preview it again.",
  );
}

export async function confirmDrep(caller: ApiCaller, draft: VerifiedDraft): Promise<V1GovernanceTxCreateResponse> {
  return confirmGovernance(
    caller,
    draft,
    async (treasuryId, request) => {
      const action = request.action;
      if (typeof action !== "string") throw new BadRequestError("This draft is not valid: preview it again");
      return planDrep(
        {
          treasuryId,
          action: action as DrepAction,
          anchorJson:
            request.anchorJson && typeof request.anchorJson === "object" && !Array.isArray(request.anchorJson)
              ? (request.anchorJson as Record<string, unknown>)
              : undefined,
          givenName: typeof request.givenName === "string" ? request.givenName : undefined,
          motivations: typeof request.motivations === "string" ? request.motivations : undefined,
          objectives: typeof request.objectives === "string" ? request.objectives : undefined,
          qualifications: typeof request.qualifications === "string" ? request.qualifications : undefined,
          imageUrl: typeof request.imageUrl === "string" ? request.imageUrl : undefined,
        },
        caller.wallet,
      );
    },
    "The DRep action changed since the preview (registration state or metadata). Preview it again.",
  );
}

export async function confirmVote(caller: ApiCaller, draft: VerifiedDraft): Promise<V1GovernanceTxCreateResponse> {
  return confirmGovernance(
    caller,
    draft,
    async (treasuryId, request) => {
      if (!Array.isArray(request.votes)) throw new BadRequestError("This draft is not valid: preview it again");
      const votes = request.votes.filter(
        (v): v is { txHash: string; certIndex: number; voteKind: "Yes" | "No" | "Abstain" } =>
          !!v &&
          typeof v === "object" &&
          typeof (v as { txHash?: unknown }).txHash === "string" &&
          typeof (v as { certIndex?: unknown }).certIndex === "number" &&
          ((v as { voteKind?: unknown }).voteKind === "Yes" ||
            (v as { voteKind?: unknown }).voteKind === "No" ||
            (v as { voteKind?: unknown }).voteKind === "Abstain"),
      );
      if (votes.length === 0) throw new BadRequestError("This draft is not valid: preview it again");
      return planVote(
        {
          treasuryId,
          votes,
          rationaleJson:
            request.rationaleJson && typeof request.rationaleJson === "object" && !Array.isArray(request.rationaleJson)
              ? (request.rationaleJson as Record<string, unknown>)
              : undefined,
        },
        caller.wallet,
      );
    },
    "The vote changed since the preview (DRep registration, ballots or rationale). Preview it again.",
  );
}
