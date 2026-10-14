// Shared loading + authorization for the multisig tx lifecycle routes.
import "server-only";

import type { BuildPayoutResponse } from "./api/types";
import { unitTicker, type UnitDisplay } from "./assetRegistry";
import { defaultPath, pathOffered, pathParticipants, pathRule } from "./cardano/spendingPaths";
import { asNetwork, type Network } from "./config";
import { MSG, SignerGroup, SpendingPath, TreasuryTemplate, TxState, type TxKind } from "./constants";
import { maybe, serviceClient } from "./db/client";
import { communitySlug } from "./db/communities";
import { loadTreasury, loadTreasurySigners } from "./db/treasuries";
import type {
  TransactionRow,
  TreasuryRow,
  TreasurySignerRow,
} from "./db/types";
import { isTreasuryActor, requireMember } from "./authz";
import { isUuid } from "./guards";
import { BadRequestError, ConflictError, ForbiddenError, NotFoundError } from "./errors";
import { isAdminRole } from "./roles";

export interface TxContext {
  tx: TransactionRow;
  treasury: TreasuryRow;
  signers: TreasurySignerRow[];
  /** The caller's signer row (any group), if the caller is a signer of this treasury */
  callerSigner: TreasurySignerRow | null;
}

export async function loadTxContext(
  txId: string,
  wallet: string,
): Promise<TxContext> {
  if (!isUuid(txId)) throw new NotFoundError("Transaction not found");
  const tx = maybe<TransactionRow>(
    await serviceClient()
      .from("transactions")
      .select("*")
      .eq("id", txId)
      .maybeSingle(),
    "load transaction",
  );
  if (!tx) throw new NotFoundError("Transaction not found");

  const treasury = await loadTreasury(tx.treasury_id);
  await requireMember(treasury.community_id, wallet);
  const signers = await loadTreasurySigners(treasury.id);
  const callerSigner = signers.find((s) => s.wallet_address === wallet) ?? null;

  return { tx, treasury, signers, callerSigner };
}

export function requireSigner(ctx: TxContext): TreasurySignerRow {
  if (!ctx.callerSigner) {
    throw new ForbiddenError("Caller is not a signer of this treasury");
  }
  return ctx.callerSigner;
}

/**
 * The common prologue of sign/submit/reject/delete: the tx must exist, the
 * caller must be a signer whose signature counts on the transaction's
 * spending path, and the tx must still be pending (409 otherwise).
 */
export async function loadPendingTxForSigner(
  txId: string,
  wallet: string,
): Promise<TxContext & { signer: TreasurySignerRow }> {
  const ctx = await loadTxContext(txId, wallet);
  const signer = requireSigner(ctx);
  if (!pathParticipants(pathRule(ctx.treasury, ctx.signers, ctx.tx.spending_path)).includes(wallet)) {
    throw new ForbiddenError(MSG.notPathSigner);
  }
  if (ctx.tx.state !== TxState.Pending) {
    throw new ConflictError(MSG.txNotPending);
  }
  return { ...ctx, signer };
}

export interface BuildContext {
  treasury: TreasuryRow;
  signers: TreasurySignerRow[];
  /** Caller's community role. */
  role: string;
  /** Whether the caller is a base signer (the treasury-actor rule). */
  isSigner: boolean;
  /** Every group the caller signs in. */
  callerGroups: Set<SignerGroup>;
  communitySlug: string;
  network: Network;
}

/** What a payout or payment builder returns about the tx it assembled. */
export interface BuiltTreasuryTx {
  txHash: string;
  totalByUnit: Map<string, bigint>;
  outputs: { address: string; assets: { unit: string; quantity: bigint }[] }[];
}

/** The tickers a built tx pays, first-seen order (for its description). */
export function builtTickers(built: BuiltTreasuryTx, unitDisplay: UnitDisplay): string[] {
  return [...new Set([...built.totalByUnit.keys()].map((unit) => unitTicker(unit, unitDisplay)))];
}

/** The build routes' answer: the new row, the hash, and the value moved with string quantities. */
export function builtTxResponse(txId: string, built: BuiltTreasuryTx): BuildPayoutResponse {
  return {
    txId,
    txHash: built.txHash,
    totalByUnit: Object.fromEntries(
      [...built.totalByUnit.entries()].map(([unit, quantity]) => [unit, quantity.toString()]),
    ),
    outputs: built.outputs.map((o) => ({
      address: o.address,
      assets: o.assets.map((a) => ({ unit: a.unit, quantity: a.quantity.toString() })),
    })),
  };
}

/** What every "build a tx from this treasury" route needs up front. */
export async function loadBuildContext(
  treasuryId: string,
  wallet: string,
): Promise<BuildContext> {
  const treasury = await loadTreasury(treasuryId);
  const role = await requireMember(treasury.community_id, wallet);
  const signers = await loadTreasurySigners(treasuryId);
  const callerGroups = new Set(signers.filter((s) => s.wallet_address === wallet).map((s) => s.signer_group));
  return {
    treasury,
    signers,
    role,
    isSigner: callerGroups.has(SignerGroup.Base),
    callerGroups,
    communitySlug: await communitySlug(treasury.community_id),
    network: asNetwork(treasury.network),
  };
}

/**
 * The spending path a build takes: the requested one or the template's
 * default, refused (400) when the treasury does not offer it now (a lock
 * still closed, recovery for anything but a payment).
 */
export function resolveSpendingPath(
  ctx: BuildContext,
  requested: SpendingPath | undefined,
  kind: TxKind,
  nowMs = Date.now(),
): SpendingPath {
  const path = requested ?? defaultPath(ctx.treasury.template);
  const offered = pathOffered(ctx.treasury, path, kind, nowMs);
  if (!offered.ok) throw new BadRequestError(offered.reason);
  return path;
}

/**
 * Who may build on a path: admins or base signers on every path but
 * recovery, which admins or recovery signers build (only recovery signers
 * sign it).
 */
export function requirePathBuilder(ctx: BuildContext, path: SpendingPath, message: string): void {
  if (path === SpendingPath.Recovery) {
    if (!isAdminRole(ctx.role) && !ctx.callerGroups.has(SignerGroup.Recovery)) {
      throw new ForbiddenError("Only admins or recovery signers can build on the recovery path");
    }
    return;
  }
  if (!isTreasuryActor(ctx.role, ctx.isSigner)) throw new ForbiddenError(message);
}

/**
 * The slot a transaction on this path must be valid from: the lock slot of
 * a lock-until treasury, or of a clawback treasury on its recovery path
 * (the `after` node of the script needs the validity interval to start
 * there); null for every other path.
 */
export function validFromSlotFor(treasury: TreasuryRow, path: SpendingPath): number | null {
  const lockSlot = treasury.lock_slot === null ? null : Number(treasury.lock_slot);
  if (treasury.template === TreasuryTemplate.LockUntil) return lockSlot;
  if (treasury.template === TreasuryTemplate.Clawback && path === SpendingPath.Recovery) return lockSlot;
  return null;
}
