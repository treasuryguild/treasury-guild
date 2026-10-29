// SDK signer invites: a draft treasury whose base signers connect and
// contribute a stake address (and optional DRep key hash) before the
// treasury row exists. Service-role only; the stake address is not returned
// to the browser.
import "server-only";

import type { SignerDraftView } from "@/lib/api/types";
import { addressToNetwork, checkValidAddress, checkValidStakeKey } from "@/lib/cardano/multisigSDK";
import { asNetwork, networkName, type Network } from "@/lib/config";
import { BadRequestError, NotFoundError } from "@/lib/errors";
import { SIGNER_DRAFT_TTL_MS } from "@/lib/invites/options";
import { generateInviteToken, hashInviteToken } from "@/lib/invites/token";
import { check, maybe, relation, rows, rpc, serviceClient } from "./client";
import {
  TREASURY_SIGNER_DRAFT_COLUMNS,
  TREASURY_SIGNER_DRAFT_SIGNER_COLUMNS,
  type TreasurySignerDraftRow,
  type TreasurySignerDraftSignerRow,
} from "./types";

const BAD_REQUEST = { "22023": BadRequestError };

export interface DraftSignerInput {
  address: string;
  name?: string;
  stakeAddress?: string;
  drepKeyHash?: string;
}

/** Stake and DRep as stored, for creating the treasury. Not an API shape. */
export interface OpenSignerDraft {
  id: string;
  signers: {
    address: string;
    name: string | null;
    stakeAddress: string | null;
    drepKeyHash: string | null;
  }[];
}

interface DraftWithSigners extends TreasurySignerDraftRow {
  treasury_signer_draft_signers: TreasurySignerDraftSignerRow[] | TreasurySignerDraftSignerRow | null;
  communities?: { name: string; slug: string; network: number } | { name: string; slug: string; network: number }[] | null;
}

function signerList(value: DraftWithSigners["treasury_signer_draft_signers"]): TreasurySignerDraftSignerRow[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return [...list].sort((a, b) => a.position - b.position);
}

function toView(row: DraftWithSigners): SignerDraftView {
  return {
    id: row.id,
    communityId: row.community_id,
    name: row.name,
    required: row.required,
    workgroupId: row.workgroup_id,
    expiresAt: row.expires_at,
    signers: signerList(row.treasury_signer_draft_signers).map((s) => ({
      address: s.wallet_address,
      name: s.display_name,
      stakeReceived: s.stake_address !== null,
      drepReceived: s.drep_key_hash !== null,
    })),
  };
}

function openFrom(row: DraftWithSigners): OpenSignerDraft {
  return {
    id: row.id,
    signers: signerList(row.treasury_signer_draft_signers).map((s) => ({
      address: s.wallet_address,
      name: s.display_name,
      stakeAddress: s.stake_address,
      drepKeyHash: s.drep_key_hash,
    })),
  };
}

const DRAFT_SELECT =
  `${TREASURY_SIGNER_DRAFT_COLUMNS}, treasury_signer_draft_signers(${TREASURY_SIGNER_DRAFT_SIGNER_COLUMNS})`;

function assertPaymentAddresses(signers: DraftSignerInput[], network: Network): void {
  for (const signer of signers) {
    if (!checkValidAddress(signer.address)) {
      throw new BadRequestError(`Invalid signer address: ${signer.address}`);
    }
    if (addressToNetwork(signer.address) !== network) {
      throw new BadRequestError(
        `Signer ${signer.address} is not a ${networkName(network)} address; this community runs on ${networkName(network)}`,
      );
    }
  }
}

function assertOwnStake(stakeAddress: string, network: Network): void {
  if (!checkValidStakeKey(stakeAddress) || addressToNetwork(stakeAddress) !== network) {
    throw new BadRequestError(
      addressToNetwork(stakeAddress) !== network
        ? "Stake address is on the wrong network"
        : "Invalid stake address",
    );
  }
}

async function loadDraft(draftId: string): Promise<DraftWithSigners | null> {
  return maybe<DraftWithSigners>(
    await serviceClient()
      .from("treasury_signer_drafts")
      .select(DRAFT_SELECT)
      .eq("id", draftId)
      .maybeSingle(),
    "load signer draft",
  );
}

function stillOpen(row: DraftWithSigners): boolean {
  return Date.parse(row.expires_at) > Date.now();
}

export async function createSignerDraft(input: {
  communityId: string;
  createdBy: string;
  name: string;
  required: number;
  workgroupId: string | null;
  network: Network;
  signers: DraftSignerInput[];
}): Promise<{ draft: SignerDraftView; token: string }> {
  assertPaymentAddresses(input.signers, input.network);
  const own = input.signers.find((s) => s.address === input.createdBy);
  if (own?.stakeAddress) assertOwnStake(own.stakeAddress, input.network);

  const token = generateInviteToken();
  const id = rpc<string>(
    await serviceClient().rpc("create_treasury_signer_draft", {
      p_community_id: input.communityId,
      p_token_hash: hashInviteToken(token),
      p_created_by: input.createdBy,
      p_name: input.name,
      p_required: input.required,
      p_workgroup_id: input.workgroupId,
      p_expires_at: new Date(Date.now() + SIGNER_DRAFT_TTL_MS).toISOString(),
      p_signers: input.signers.map((s) => ({
        address: s.address,
        name: s.name ?? "",
        ...(s.address === input.createdBy && s.stakeAddress
          ? {
              stakeAddress: s.stakeAddress,
              ...(s.drepKeyHash ? { drepKeyHash: s.drepKeyHash.toLowerCase() } : {}),
            }
          : {}),
      })),
    }),
    BAD_REQUEST,
  );
  const row = await loadDraft(id);
  if (!row) throw new NotFoundError("Signer invite not found");
  return { draft: toView(row), token };
}

export async function listOpenSignerDrafts(communityId: string): Promise<SignerDraftView[]> {
  const listed = rows<DraftWithSigners>(
    await serviceClient()
      .from("treasury_signer_drafts")
      .select(DRAFT_SELECT)
      .eq("community_id", communityId)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false }),
    "list signer drafts",
  );
  return listed.map(toView);
}

/** The admin view, or null when the draft is missing or expired. */
export async function getSignerDraft(draftId: string): Promise<SignerDraftView | null> {
  const row = await loadDraft(draftId);
  if (!row || !stillOpen(row)) return null;
  return toView(row);
}

/** Keys for treasury creation. Null when the draft is missing, expired, or another community's. */
export async function loadOpenSignerDraft(
  draftId: string,
  communityId: string,
): Promise<OpenSignerDraft | null> {
  const row = await loadDraft(draftId);
  if (!row || row.community_id !== communityId || !stillOpen(row)) return null;
  return openFrom(row);
}

export async function saveSignerDraft(input: {
  draftId: string;
  communityId: string;
  actor: string;
  name: string;
  required: number;
  workgroupId: string | null;
  network: Network;
  signers: DraftSignerInput[];
}): Promise<SignerDraftView> {
  const existing = await loadDraft(input.draftId);
  if (!existing || existing.community_id !== input.communityId || !stillOpen(existing)) {
    throw new NotFoundError("Signer invite not found");
  }
  assertPaymentAddresses(input.signers, input.network);
  const own = input.signers.find((s) => s.address === input.actor);
  if (own?.stakeAddress) assertOwnStake(own.stakeAddress, input.network);

  rpc<null>(
    await serviceClient().rpc("save_treasury_signer_draft", {
      p_draft_id: input.draftId,
      p_name: input.name,
      p_required: input.required,
      p_workgroup_id: input.workgroupId,
      p_signers: input.signers.map((s) => ({ address: s.address, name: s.name ?? "" })),
      p_actor: input.actor,
      p_stake_address: own?.stakeAddress ?? null,
      p_drep_key_hash: own?.stakeAddress && own.drepKeyHash ? own.drepKeyHash.toLowerCase() : null,
    }),
    BAD_REQUEST,
  );
  const row = await loadDraft(input.draftId);
  if (!row) throw new NotFoundError("Signer invite not found");
  return toView(row);
}

export async function deleteSignerDraft(draftId: string): Promise<void> {
  check(
    await serviceClient().from("treasury_signer_drafts").delete().eq("id", draftId),
    "delete signer draft",
  );
}

export interface SignerDraftPreview {
  communityName: string;
  treasuryName: string;
  slug: string;
  network: number;
  expiresAt: string;
  valid: boolean;
  filled: number;
  total: number;
}

export async function previewSignerDraft(token: string): Promise<SignerDraftPreview | null> {
  const row = maybe<DraftWithSigners>(
    await serviceClient()
      .from("treasury_signer_drafts")
      .select(`${DRAFT_SELECT}, communities!inner(name, slug, network)`)
      .eq("token_hash", hashInviteToken(token))
      .maybeSingle(),
    "preview signer draft",
  );
  if (!row) return null;
  const community = relation(row.communities ?? { name: "", slug: "", network: 0 });
  const signers = signerList(row.treasury_signer_draft_signers);
  return {
    communityName: community.name,
    treasuryName: row.name,
    slug: community.slug,
    network: community.network,
    expiresAt: row.expires_at,
    valid: stillOpen(row),
    filled: signers.filter((s) => s.stake_address !== null).length,
    total: signers.length,
  };
}

async function writeSignerKeys(
  tokenHash: string,
  wallet: string,
  stakeAddress: string,
  drepKeyHash: string | null,
  network: Network,
): Promise<void> {
  if (addressToNetwork(wallet) !== network) {
    throw new BadRequestError(
      network === 1
        ? "This community runs on mainnet: use a mainnet address"
        : "This community runs on preprod: use a preprod (addr_test…) address",
    );
  }
  assertOwnStake(stakeAddress, network);
  rpc<null>(
    await serviceClient().rpc("contribute_treasury_signer_keys", {
      p_token_hash: tokenHash,
      p_wallet: wallet,
      p_stake_address: stakeAddress,
      p_drep_key_hash: drepKeyHash,
    }),
    BAD_REQUEST,
  );
}

/** The invite page: the session wallet is the only row that can be written. */
export async function contributeSignerDraft(
  token: string,
  wallet: string,
  stakeAddress: string,
  drepKeyHash: string | null,
): Promise<void> {
  const preview = await previewSignerDraft(token);
  if (!preview?.valid) throw new NotFoundError("Signer invite not found");
  await writeSignerKeys(hashInviteToken(token), wallet, stakeAddress, drepKeyHash, asNetwork(preview.network));
}

/** The creating admin sending their own keys, addressed by draft id. */
export async function contributeSignerDraftById(
  draftId: string,
  wallet: string,
  stakeAddress: string,
  drepKeyHash: string | null,
): Promise<SignerDraftView> {
  const row = await loadDraft(draftId);
  if (!row || !stillOpen(row)) throw new NotFoundError("Signer invite not found");
  const community = maybe<{ network: number }>(
    await serviceClient().from("communities").select("network").eq("id", row.community_id).maybeSingle(),
    "signer draft community",
  );
  if (!community) throw new NotFoundError("Signer invite not found");
  await writeSignerKeys(row.token_hash, wallet, stakeAddress, drepKeyHash, asNetwork(community.network));
  const updated = await loadDraft(draftId);
  if (!updated) throw new NotFoundError("Signer invite not found");
  return toView(updated);
}

/** Expired drafts (reconcile sweep). Signer rows cascade. */
export async function purgeSignerDrafts(now: Date): Promise<number> {
  const res = await serviceClient().rpc("purge_treasury_signer_drafts", {
    p_now: now.toISOString(),
  });
  check(res, "purge signer drafts");
  return (res.data as number | null) ?? 0;
}
