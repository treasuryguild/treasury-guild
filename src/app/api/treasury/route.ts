import { parseJson, parseQuery, sessionRoute } from "@/lib/api/route";
import { createTreasurySchema, treasuryIdQuerySchema, type CreateTreasuryBody } from "@/lib/api/schemas";
import type { CreateTreasuryResponse, TreasuryDetailsResponse } from "@/lib/api/types";
import { memberRole, requireAdmin, requireMember } from "@/lib/authz";
import {
  MultisigWallet,
  addressToNetwork,
  checkValidAddress,
  paymentKeyHash,
  stakeKeyHash,
  type MultisigKey,
} from "@/lib/cardano/multisigSDK";
import { slotAt, slotTime } from "@/lib/cardano/slots";
import { shapeProblem, sortedGroup, templateScript, type KeyGroup, type TreasuryShape } from "@/lib/cardano/templates";
import { decodeTreasuryCbor } from "@/lib/cardano/treasuryImport";
import { asNetwork, networkName, type Network } from "@/lib/config";
import { COSIGNER_DISPLAY_NAME, CosignerKind, MIN_LOCK_LEAD_MS, Role, SignerGroup, TreasuryTemplate } from "@/lib/constants";
import { generateCosignerKey } from "@/lib/cosigner/keys";
import { requireCommunity, setPrimaryTreasury } from "@/lib/db/communities";
import { insertCosignerKey } from "@/lib/db/cosigner";
import { addMember, promoteMembersToAdmin } from "@/lib/db/membership";
import {
  countCommunityTreasuries,
  deleteTreasury,
  findTreasuryByAddress,
  insertTreasury,
  insertTreasurySigners,
  loadTreasuryWithSigners,
  tagInternalTransfers,
} from "@/lib/db/treasuries";
import type { TreasurySignerRow } from "@/lib/db/types";
import { setWorkgroupTreasury } from "@/lib/db/workgroupRouting";
import { requireActiveWorkgroup, workgroupCommunityId } from "@/lib/db/workgroups";
import { BadRequestError, ConflictError, errorMessage, InvariantError } from "@/lib/errors";
import { describeTreasury } from "@/lib/treasury";

const LINK_REASON = "Linked when the treasury was created";

type SignerRow = Pick<
  TreasurySignerRow,
  "wallet_address" | "key_hash" | "display_name" | "signer_group" | "stake_key_hash" | "drep_key_hash"
>;

/** Treasury details (native script, CBOR, signers) for any community member. */
export const GET = sessionRoute(async (req, { session }) => {
  const { treasuryId } = parseQuery(req, treasuryIdQuerySchema);
  const { treasury, signers } = await loadTreasuryWithSigners(treasuryId);
  await requireMember(treasury.community_id, session.wallet);
  return { treasury: describeTreasury(treasury, signers) } satisfies TreasuryDetailsResponse;
});

function signerRow(
  input: { address: string; name?: string; stakeAddress?: string; drepKeyHash?: string },
  group: SignerGroup,
): SignerRow {
  return {
    wallet_address: input.address,
    key_hash: paymentKeyHash(input.address),
    display_name: input.name?.trim() || null,
    signer_group: group,
    stake_key_hash: group === SignerGroup.Base && input.stakeAddress
      ? stakeKeyHash(input.stakeAddress)
      : null,
    drep_key_hash: group === SignerGroup.Base && input.drepKeyHash
      ? input.drepKeyHash.toLowerCase()
      : null,
  };
}

/** The base group's threshold, checked against its size for `atLeast`. */
function groupThreshold(scriptType: KeyGroup["scriptType"], required: number | undefined, size: number, label: string): number {
  const threshold = required ?? 1;
  if (scriptType === "atLeast" && (threshold < 1 || threshold > size)) {
    throw new BadRequestError(`${label} required signatures must be between 1 and the number of its signers`);
  }
  return scriptType === "all" ? size : scriptType === "any" ? 1 : threshold;
}

/** The lock date in words → the slot and the slot's own time (the slot is the truth). */
function resolveLock(lockUntil: string | undefined, network: Network): { lockSlot: number; lockUntil: string } {
  const ms = lockUntil ? Date.parse(lockUntil) : NaN;
  if (!Number.isFinite(ms)) throw new BadRequestError("Choose a valid lock date");
  if (ms < Date.now() + MIN_LOCK_LEAD_MS) throw new BadRequestError("The lock date must be at least one hour in the future");
  const lockSlot = slotAt(network, ms);
  return { lockSlot, lockUntil: slotTime(network, lockSlot) };
}

/**
 * The rows of a new (not imported) treasury and its shape, from the request's
 * groups. Every address is checked here; the shape's own sanity (a key in two
 * groups, a co-signer that adds nothing) is `shapeProblem`'s.
 */
function newTreasuryRows(body: CreateTreasuryBody, network: Network): {
  rows: SignerRow[];
  shape: TreasuryShape;
  lockUntil: string | null;
  cosignerKind: CosignerKind | null;
  appKey: ReturnType<typeof generateCosignerKey> | null;
} {
  const rows: SignerRow[] = body.signers.map((s) => signerRow(s, SignerGroup.Base));
  const base = sortedGroup({
    scriptType: body.scriptType,
    required: groupThreshold(body.scriptType, body.required, rows.length, "The base group's"),
    keyHashes: rows.map((r) => r.key_hash),
  });
  let recovery: KeyGroup | null = null;
  let lock: { lockSlot: number; lockUntil: string } | null = null;
  let cosignerKeyHash: string | null = null;
  let cosignerKind: CosignerKind | null = null;
  let appKey: ReturnType<typeof generateCosignerKey> | null = null;

  if (body.template === TreasuryTemplate.Clawback || body.template === TreasuryTemplate.LockUntil) {
    lock = resolveLock(body.lockUntil, network);
  }
  if (body.template === TreasuryTemplate.Clawback && body.recovery) {
    const recoveryRows = body.recovery.signers.map((s) => signerRow(s, SignerGroup.Recovery));
    rows.push(...recoveryRows);
    recovery = sortedGroup({
      scriptType: body.recovery.scriptType,
      required: groupThreshold(body.recovery.scriptType, body.recovery.required, recoveryRows.length, "The recovery group's"),
      keyHashes: recoveryRows.map((r) => r.key_hash),
    });
  }
  if (body.template === TreasuryTemplate.Cosigner && body.cosigner) {
    if (body.cosigner.kind === CosignerKind.Member) {
      const row = signerRow({ address: body.cosigner.address }, SignerGroup.Cosigner);
      rows.push(row);
      cosignerKeyHash = row.key_hash;
      cosignerKind = CosignerKind.Member;
    } else {
      // The key is generated here and stored encrypted once the treasury
      // row exists; the row below is what signed_addresses will name.
      appKey = generateCosignerKey(network);
      rows.push({
        wallet_address: appKey.walletAddress,
        key_hash: appKey.keyHash,
        display_name: COSIGNER_DISPLAY_NAME,
        signer_group: SignerGroup.Cosigner,
        stake_key_hash: null,
        drep_key_hash: null,
      });
      cosignerKeyHash = appKey.keyHash;
      cosignerKind = CosignerKind.App;
    }
  }
  return {
    rows,
    shape: { template: body.template, base, recovery, lockSlot: lock?.lockSlot ?? null, cosignerKeyHash },
    lockUntil: lock?.lockUntil ?? null,
    cosignerKind,
    appKey,
  };
}

/** The rows of an imported treasury: every key of the script matched to one wallet, grouped by the shape. */
function importedTreasuryRows(body: CreateTreasuryBody, shape: TreasuryShape): SignerRow[] {
  const groupOf = new Map<string, SignerGroup>();
  for (const k of shape.base.keyHashes) groupOf.set(k, SignerGroup.Base);
  for (const k of shape.recovery?.keyHashes ?? []) groupOf.set(k, SignerGroup.Recovery);
  if (shape.cosignerKeyHash) groupOf.set(shape.cosignerKeyHash, SignerGroup.Cosigner);
  const rows: SignerRow[] = [];
  for (const s of body.signers) {
    const keyHash = paymentKeyHash(s.address);
    const group = groupOf.get(keyHash);
    if (!group) throw new BadRequestError("Provide one matching wallet address for every signer in the imported script");
    rows.push(signerRow(s, group));
  }
  if (rows.length !== groupOf.size || new Set(rows.map((r) => r.key_hash)).size !== rows.length) {
    throw new BadRequestError("Provide one matching wallet address for every signer in the imported script");
  }
  return rows;
}

export const POST = sessionRoute(async (req, { session }) => {
  const body = await parseJson(req, createTreasurySchema);
  const { communityId, name, workgroupId, source } = body;
  await requireAdmin(communityId, session.wallet);
  const imported = source ? decodeTreasuryCbor(source.cbor) : null;

  // A bad workgroup pick fails here, before any wallet exists.
  if (workgroupId) {
    if ((await workgroupCommunityId(workgroupId)) !== communityId) {
      throw new BadRequestError("Choose a workgroup of this community");
    }
    await requireActiveWorkgroup(workgroupId);
  }

  // The wallet lives on the community's network (chosen at creation); a
  // signer from the other network could never produce a valid witness.
  const community = await requireCommunity(communityId);
  const network = asNetwork(community.network);
  const everyAddress = [
    ...body.signers.map((s) => s.address),
    ...(imported ? [] : (body.recovery?.signers ?? []).map((s) => s.address)),
    ...(imported || body.cosigner?.kind !== CosignerKind.Member ? [] : [body.cosigner.address]),
  ];
  const invalid = everyAddress.find((a) => !checkValidAddress(a));
  if (invalid) throw new BadRequestError(`Invalid signer address: ${invalid}`);
  const offNetwork = everyAddress.find((a) => addressToNetwork(a) !== network);
  if (offNetwork) {
    throw new BadRequestError(
      `Signer ${offNetwork} is not a ${networkName(network)} address; this community runs on ${networkName(network)}`,
    );
  }
  if (new Set(everyAddress).size !== everyAddress.length) {
    throw new BadRequestError("Duplicate signer addresses");
  }

  const built = imported
    ? {
        rows: importedTreasuryRows(body, imported.shape),
        shape: imported.shape,
        lockUntil: imported.shape.lockSlot === null ? null : slotTime(network, imported.shape.lockSlot),
        // An imported co-signer key is somebody's wallet; the app never holds it.
        cosignerKind: imported.shape.cosignerKeyHash ? CosignerKind.Member : null,
        appKey: null,
      }
    : newTreasuryRows(body, network);
  const { rows, shape } = built;
  const baseRows = rows.filter((r) => r.signer_group === SignerGroup.Base);

  // The community's first treasury becomes primary and must include its
  // creator: the caller is necessarily the owner (sole admin) at that point,
  // and its base signers become the community's admins.
  const treasuryCount = await countCommunityTreasuries(communityId);
  const isPrimary = treasuryCount === 0;
  if (isPrimary && !baseRows.some((s) => s.wallet_address === session.wallet)) {
    throw new BadRequestError("You must be a signer of the community's first treasury");
  }
  const keys = rows.map((r) => r.key_hash);
  if (new Set(keys).size !== keys.length) {
    throw new BadRequestError("A wallet cannot be in two groups of the same treasury");
  }
  const problem = shapeProblem(shape);
  if (problem) throw new BadRequestError(problem);

  // Recovery signers and a member co-signer are not promoted: they must
  // already be members, or they could never see the treasury.
  for (const row of rows) {
    if (row.signer_group === SignerGroup.Base || row.display_name === COSIGNER_DISPLAY_NAME && built.appKey) continue;
    if (!(await memberRole(communityId, row.wallet_address))) {
      throw new BadRequestError(
        `${row.signer_group === SignerGroup.Recovery ? "Recovery signers" : "The co-signer"} must already be community members: ${row.wallet_address}`,
      );
    }
  }

  const paymentScript = imported?.paymentScript ?? templateScript(shape);
  const baseKeys: MultisigKey[] = [];
  for (const s of baseRows) {
    baseKeys.push({ keyHash: s.key_hash, role: 0, name: s.display_name ?? "" });
    if (s.stake_key_hash) baseKeys.push({ keyHash: s.stake_key_hash, role: 2, name: s.display_name ?? "" });
    if (s.drep_key_hash) baseKeys.push({ keyHash: s.drep_key_hash, role: 3, name: s.display_name ?? "" });
  }
  const msWallet = new MultisigWallet(name, baseKeys, "", shape.base.required, network, undefined, shape.base.scriptType, paymentScript);
  if (baseRows.some((s) => s.stake_key_hash) && !msWallet.stakingEnabled()) {
    throw new BadRequestError("Every base signer needs a stake address for a stakeable (SDK) treasury");
  }
  const stakeCredentialHash = msWallet.stakingEnabled()
    ? msWallet.getStakeCredentialHash() ?? null
    : null;
  const { address, scriptCbor } = msWallet.getScript();
  if (!scriptCbor) throw new InvariantError("Failed to derive multisig script");

  const treasury = await insertTreasury({
    community_id: communityId,
    name,
    network,
    required: shape.base.required,
    script_type: shape.base.scriptType,
    address,
    script_cbor: scriptCbor,
    stake_credential_hash: stakeCredentialHash,
    template: shape.template,
    lock_slot: shape.lockSlot,
    lock_until: built.lockUntil,
    recovery_script_type: shape.recovery?.scriptType ?? null,
    recovery_required: shape.recovery?.required ?? null,
    cosigner_kind: built.cosignerKind,
  });
  if (!treasury) {
    const existing = await findTreasuryByAddress(address);
    if (existing?.community_id === communityId && existing.archived_at) {
      throw new ConflictError(
        "This treasury is archived. Restore it to use the same wallet again.",
        { restoreTreasuryId: existing.id },
      );
    }
    throw new ConflictError(
      imported
        ? "A treasury with this address already exists"
        : "A treasury with this exact signer set and threshold already exists (same signers produce the same address). Change the signers or threshold to create a distinct wallet.",
    );
  }

  try {
    if (built.appKey) {
      await insertCosignerKey({
        treasury_id: treasury.id,
        key_hash: built.appKey.keyHash,
        public_key_hex: built.appKey.publicKeyHex,
        encrypted_key: built.appKey.encryptedKey,
      });
    }
    await insertTreasurySigners(treasury.id, rows);
  } catch (err) {
    // A treasury without its key or signers could never spend: undo it.
    await deleteTreasury(treasury.id).catch((cleanupErr) => console.error(`compensating delete of treasury ${treasury.id} failed`, cleanupErr));
    throw err;
  }

  // Primary treasury base signers are community admins; later treasuries'
  // base signers are only members (they act for that wallet alone). Recovery
  // signers and the co-signer keep their roles either way.
  const signerWallets = baseRows.map((s) => s.wallet_address);
  if (isPrimary) {
    await setPrimaryTreasury(communityId, treasury.id);
    for (const wallet of signerWallets) {
      await addMember(communityId, wallet, Role.Admin);
    }
    await promoteMembersToAdmin(communityId, signerWallets);
  } else {
    for (const wallet of signerWallets) {
      await addMember(communityId, wallet, Role.Member);
    }
  }

  // Other treasuries may already hold inflows from this address: they are
  // internal transfers from now on. The new wallet's own history arrives
  // with its first poll.
  await tagInternalTransfers(communityId);

  const { link, linkError } = workgroupId
    ? await linkWorkgroup(workgroupId, treasury.id, session.wallet)
    : { link: null, linkError: null };

  return { treasury, link, linkError } satisfies CreateTreasuryResponse;
});

/**
 * Make the new wallet the workgroup's payment wallet: from this budget period
 * when nothing was paid in it from another wallet, otherwise from the next.
 * The treasury already exists, so a refusal (a later change is already
 * scheduled) is reported instead of failing the request.
 */
async function linkWorkgroup(
  workgroupId: string,
  treasuryId: string,
  actor: string,
): Promise<Pick<CreateTreasuryResponse, "link" | "linkError">> {
  const assign = (effective: "current" | "next") =>
    setWorkgroupTreasury({ workgroupId, treasuryId, effective, actor, reason: LINK_REASON })
      .then((startsOn) => ({ workgroupId, startsOn, effective }));
  try {
    const link = await assign("current").catch((e: unknown) => {
      if (e instanceof ConflictError) return assign("next");
      throw e;
    });
    return { link, linkError: null };
  } catch (e) {
    console.error(`link treasury ${treasuryId} to workgroup ${workgroupId} failed`, e);
    return { link: null, linkError: errorMessage(e, "The workgroup could not be linked") };
  }
}
