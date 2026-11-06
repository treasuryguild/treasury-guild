// CBOR / CIP-0146 import invites: a draft whose key-hash slots are claimed by
// connecting wallets (or an admin paste) before the treasury row exists.
// Service-role only; public preview never includes key hashes or addresses.
import "server-only";

import type { ImportDraftView } from "@/lib/api/types";
import {
  addressToNetwork,
  checkValidAddress,
  paymentKeyHash,
} from "@/lib/cardano/multisigSDK";
import { asNetwork, networkName, type Network } from "@/lib/config";
import type { SignerGroup } from "@/lib/constants";
import { BadRequestError, NotFoundError } from "@/lib/errors";
import { IMPORT_DRAFT_TTL_MS } from "@/lib/invites/options";
import { generateInviteToken, hashInviteToken } from "@/lib/invites/token";
import { check, maybe, relation, rows, rpc, serviceClient } from "./client";
import {
  TREASURY_IMPORT_DRAFT_COLUMNS,
  TREASURY_IMPORT_DRAFT_SIGNER_COLUMNS,
  type TreasuryImportDraftRow,
  type TreasuryImportDraftSignerRow,
} from "./types";

const BAD_REQUEST = { "22023": BadRequestError };

export interface ImportDraftSignerInput {
  keyHash: string;
  group: SignerGroup;
  name?: string;
}

/** Claimed addresses for creating the treasury. Not an API shape. */
export interface OpenImportDraft {
  id: string;
  scriptCbor: string;
  stakeCredentialHash: string | null;
  name: string;
  workgroupId: string | null;
  signers: {
    keyHash: string;
    group: SignerGroup;
    address: string;
    name: string | null;
  }[];
}

interface DraftWithSigners extends TreasuryImportDraftRow {
  treasury_import_draft_signers: TreasuryImportDraftSignerRow[] | TreasuryImportDraftSignerRow | null;
  communities?: { name: string; slug: string; network: number } | { name: string; slug: string; network: number }[] | null;
}

function signerList(value: DraftWithSigners["treasury_import_draft_signers"]): TreasuryImportDraftSignerRow[] {
  if (!value) return [];
  const list = Array.isArray(value) ? value : [value];
  return [...list].sort((a, b) => a.position - b.position);
}

function toView(row: DraftWithSigners): ImportDraftView {
  const signers = signerList(row.treasury_import_draft_signers);
  return {
    id: row.id,
    communityId: row.community_id,
    name: row.name,
    workgroupId: row.workgroup_id,
    expiresAt: row.expires_at,
    scriptCbor: row.script_cbor,
    stakeCredentialHash: row.stake_credential_hash,
    filled: signers.filter((s) => s.wallet_address !== null).length,
    total: signers.length,
    signers: signers.map((s) => ({
      keyHash: s.key_hash,
      group: s.signer_group,
      address: s.wallet_address,
      name: s.display_name,
      claimed: s.wallet_address !== null,
    })),
  };
}

const DRAFT_SELECT =
  `${TREASURY_IMPORT_DRAFT_COLUMNS}, treasury_import_draft_signers(${TREASURY_IMPORT_DRAFT_SIGNER_COLUMNS})`;

function stillOpen(row: DraftWithSigners): boolean {
  return Date.parse(row.expires_at) > Date.now();
}

async function loadDraft(draftId: string): Promise<DraftWithSigners | null> {
  return maybe<DraftWithSigners>(
    await serviceClient()
      .from("treasury_import_drafts")
      .select(DRAFT_SELECT)
      .eq("id", draftId)
      .maybeSingle(),
    "load import draft",
  );
}

function assertNetworkAddress(address: string, network: Network): void {
  if (!checkValidAddress(address)) {
    throw new BadRequestError(`Invalid signer address: ${address}`);
  }
  if (addressToNetwork(address) !== network) {
    throw new BadRequestError(
      `Signer ${address} is not a ${networkName(network)} address; this community runs on ${networkName(network)}`,
    );
  }
}

export async function createImportDraft(input: {
  communityId: string;
  createdBy: string;
  name: string;
  workgroupId: string | null;
  network: Network;
  scriptCbor: string;
  stakeCredentialHash: string | null;
  signers: ImportDraftSignerInput[];
}): Promise<{ draft: ImportDraftView; token: string }> {
  assertNetworkAddress(input.createdBy, input.network);
  const creatorKeyHash = paymentKeyHash(input.createdBy).toLowerCase();
  const token = generateInviteToken();
  const id = rpc<string>(
    await serviceClient().rpc("create_treasury_import_draft", {
      p_community_id: input.communityId,
      p_token_hash: hashInviteToken(token),
      p_created_by: input.createdBy,
      p_creator_key_hash: creatorKeyHash,
      p_name: input.name,
      p_workgroup_id: input.workgroupId,
      p_expires_at: new Date(Date.now() + IMPORT_DRAFT_TTL_MS).toISOString(),
      p_script_cbor: input.scriptCbor,
      p_stake_credential_hash: input.stakeCredentialHash,
      p_signers: input.signers.map((s) => ({
        keyHash: s.keyHash.toLowerCase(),
        group: s.group,
        name: s.name ?? "",
      })),
    }),
    BAD_REQUEST,
  );
  const row = await loadDraft(id);
  if (!row) throw new NotFoundError("Import invite not found");
  return { draft: toView(row), token };
}

export async function listOpenImportDrafts(communityId: string): Promise<ImportDraftView[]> {
  const listed = rows<DraftWithSigners>(
    await serviceClient()
      .from("treasury_import_drafts")
      .select(DRAFT_SELECT)
      .eq("community_id", communityId)
      .gt("expires_at", new Date().toISOString())
      .order("created_at", { ascending: false }),
    "list import drafts",
  );
  return listed.map(toView);
}

export async function getImportDraft(draftId: string): Promise<ImportDraftView | null> {
  const row = await loadDraft(draftId);
  if (!row || !stillOpen(row)) return null;
  return toView(row);
}

/** Keys for treasury creation. Null when missing, expired, incomplete, or another community's. */
export async function loadOpenImportDraft(
  draftId: string,
  communityId: string,
): Promise<OpenImportDraft | null> {
  const row = await loadDraft(draftId);
  if (!row || row.community_id !== communityId || !stillOpen(row)) return null;
  const signers = signerList(row.treasury_import_draft_signers);
  if (signers.some((s) => !s.wallet_address)) return null;
  return {
    id: row.id,
    scriptCbor: row.script_cbor,
    stakeCredentialHash: row.stake_credential_hash,
    name: row.name,
    workgroupId: row.workgroup_id,
    signers: signers.map((s) => ({
      keyHash: s.key_hash,
      group: s.signer_group,
      address: s.wallet_address!,
      name: s.display_name,
    })),
  };
}

export async function saveImportDraft(input: {
  draftId: string;
  communityId: string;
  name: string;
  workgroupId: string | null;
}): Promise<ImportDraftView> {
  const existing = await loadDraft(input.draftId);
  if (!existing || existing.community_id !== input.communityId || !stillOpen(existing)) {
    throw new NotFoundError("Import invite not found");
  }
  rpc<null>(
    await serviceClient().rpc("save_treasury_import_draft", {
      p_draft_id: input.draftId,
      p_name: input.name,
      p_workgroup_id: input.workgroupId,
    }),
    BAD_REQUEST,
  );
  const row = await loadDraft(input.draftId);
  if (!row) throw new NotFoundError("Import invite not found");
  return toView(row);
}

export async function deleteImportDraft(draftId: string): Promise<void> {
  check(
    await serviceClient().from("treasury_import_drafts").delete().eq("id", draftId),
    "delete import draft",
  );
}

export interface ImportDraftPreview {
  communityName: string;
  treasuryName: string;
  slug: string;
  network: number;
  expiresAt: string;
  valid: boolean;
  filled: number;
  total: number;
}

export async function previewImportDraft(token: string): Promise<ImportDraftPreview | null> {
  const row = maybe<DraftWithSigners>(
    await serviceClient()
      .from("treasury_import_drafts")
      .select(`${DRAFT_SELECT}, communities!inner(name, slug, network)`)
      .eq("token_hash", hashInviteToken(token))
      .maybeSingle(),
    "preview import draft",
  );
  if (!row) return null;
  const community = relation(row.communities ?? { name: "", slug: "", network: 0 });
  const signers = signerList(row.treasury_import_draft_signers);
  return {
    communityName: community.name,
    treasuryName: row.name,
    slug: community.slug,
    network: community.network,
    expiresAt: row.expires_at,
    valid: stillOpen(row),
    filled: signers.filter((s) => s.wallet_address !== null).length,
    total: signers.length,
  };
}

async function claimWithKeyHash(
  opts: {
    tokenHash: string | null;
    draftId: string | null;
    wallet: string;
    displayName: string | null;
    network: Network;
  },
): Promise<void> {
  assertNetworkAddress(opts.wallet, opts.network);
  const keyHash = paymentKeyHash(opts.wallet).toLowerCase();
  if (opts.tokenHash) {
    rpc<null>(
      await serviceClient().rpc("claim_treasury_import_invite", {
        p_token_hash: opts.tokenHash,
        p_wallet: opts.wallet,
        p_key_hash: keyHash,
        p_display_name: opts.displayName,
      }),
      BAD_REQUEST,
    );
    return;
  }
  if (!opts.draftId) throw new NotFoundError("Import invite not found");
  rpc<null>(
    await serviceClient().rpc("claim_treasury_import_draft_slot", {
      p_draft_id: opts.draftId,
      p_wallet: opts.wallet,
      p_key_hash: keyHash,
      p_display_name: opts.displayName,
    }),
    BAD_REQUEST,
  );
}

/** The invite page: the session wallet claims the matching key-hash slot. */
export async function claimImportDraft(
  token: string,
  wallet: string,
  displayName: string | null,
): Promise<void> {
  const preview = await previewImportDraft(token);
  if (!preview?.valid) throw new NotFoundError("Import invite not found");
  await claimWithKeyHash({
    tokenHash: hashInviteToken(token),
    draftId: null,
    wallet,
    displayName,
    network: asNetwork(preview.network),
  });
}

/** The creating admin claiming their own wallet against a draft id. */
export async function claimImportDraftById(
  draftId: string,
  wallet: string,
  displayName: string | null,
): Promise<ImportDraftView> {
  const row = await loadDraft(draftId);
  if (!row || !stillOpen(row)) throw new NotFoundError("Import invite not found");
  const community = maybe<{ network: number }>(
    await serviceClient().from("communities").select("network").eq("id", row.community_id).maybeSingle(),
    "import draft community",
  );
  if (!community) throw new NotFoundError("Import invite not found");
  await claimWithKeyHash({
    tokenHash: null,
    draftId,
    wallet,
    displayName,
    network: asNetwork(community.network),
  });
  const updated = await loadDraft(draftId);
  if (!updated) throw new NotFoundError("Import invite not found");
  return toView(updated);
}

/** Admin paste: address must hash to the named key slot. */
export async function adminSetImportSlot(input: {
  draftId: string;
  communityId: string;
  keyHash: string;
  address: string;
  name?: string;
  network: Network;
}): Promise<ImportDraftView> {
  const existing = await loadDraft(input.draftId);
  if (!existing || existing.community_id !== input.communityId || !stillOpen(existing)) {
    throw new NotFoundError("Import invite not found");
  }
  assertNetworkAddress(input.address, input.network);
  const keyHash = paymentKeyHash(input.address).toLowerCase();
  if (keyHash !== input.keyHash.toLowerCase()) {
    throw new BadRequestError("That address does not match this signer key");
  }
  rpc<null>(
    await serviceClient().rpc("set_treasury_import_draft_slot_address", {
      p_draft_id: input.draftId,
      p_key_hash: keyHash,
      p_wallet: input.address,
      p_display_name: input.name ?? null,
    }),
    BAD_REQUEST,
  );
  const row = await loadDraft(input.draftId);
  if (!row) throw new NotFoundError("Import invite not found");
  return toView(row);
}

/** Expired drafts (reconcile sweep). Signer rows cascade. */
export async function purgeImportDrafts(now: Date): Promise<number> {
  const res = await serviceClient().rpc("purge_treasury_import_drafts", {
    p_now: now.toISOString(),
  });
  check(res, "purge import drafts");
  return (res.data as number | null) ?? 0;
}
