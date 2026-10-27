// Server-side authorization checks used by service-role routes.
import "server-only";

import { Proposers } from "./constants";
import { maybe, rows, serviceClient } from "./db/client";
import { loadTreasury } from "./db/treasuries";
import type { TreasuryRow } from "./db/types";
import { requireWorkgroupCommunity } from "./db/workgroups";
import { ForbiddenError } from "./errors";
import { isAdminRole } from "./roles";

export { ForbiddenError };

export async function memberRole(
  communityId: string,
  wallet: string,
): Promise<string | null> {
  const row = maybe<{ role: string }>(
    await serviceClient()
      .from("community_members")
      .select("role")
      .eq("community_id", communityId)
      .eq("wallet_address", wallet)
      .maybeSingle(),
    "load member role",
  );
  return row?.role ?? null;
}

export async function requireMember(
  communityId: string,
  wallet: string,
): Promise<string> {
  const role = await memberRole(communityId, wallet);
  if (!role) throw new ForbiddenError("Not a community member");
  return role;
}

export async function requireAdmin(
  communityId: string,
  wallet: string,
): Promise<string> {
  const role = await memberRole(communityId, wallet);
  if (!role || !isAdminRole(role)) {
    throw new ForbiddenError("Requires admin role");
  }
  return role;
}

/** An admin of the workgroup's community; returns the community id (404 when the workgroup is gone). */
export async function requireWorkgroupAdmin(workgroupId: string, wallet: string): Promise<string> {
  const communityId = await requireWorkgroupCommunity(workgroupId);
  await requireAdmin(communityId, wallet);
  return communityId;
}

/** An admin of the treasury's community; returns the treasury (404 when it is gone). */
export async function requireTreasuryAdmin(treasuryId: string, wallet: string): Promise<TreasuryRow> {
  const treasury = await loadTreasury(treasuryId);
  await requireAdmin(treasury.community_id, wallet);
  return treasury;
}

/**
 * Who may start a spend from a treasury: its base signers only. Community
 * admin is not enough — that role manages the community, not every wallet.
 * `role` is unused (kept so call sites stay stable).
 */
export function isTreasuryActor(_role: string | null, isSigner: boolean): boolean {
  return isSigner;
}

export function requireTreasuryActor(
  role: string,
  isSigner: boolean,
  message: string,
): void {
  if (!isTreasuryActor(role, isSigner)) throw new ForbiddenError(message);
}

/**
 * Who may manage workgroup work (calls, task assignees, budgets): members who
 * are admins or lead every one of the given workgroups.
 */
export async function requireWorkgroupManager(
  communityId: string,
  workgroupIds: string | string[],
  wallet: string,
  message = "Only admins and workgroup leads can do this",
): Promise<void> {
  const role = await requireMember(communityId, wallet);
  const ids = typeof workgroupIds === "string" ? [workgroupIds] : workgroupIds;
  if (!isAdminRole(role) && !(await leadsAllWorkgroups(wallet, ids))) {
    throw new ForbiddenError(message);
  }
}

/**
 * Who may make a proposal of a kind (governance_settings.proposers): any
 * member, admins, or "managers": admins and leads of every workgroup the
 * proposal concerns (so a proposal concerning no workgroup is admins only).
 */
export async function requireProposer(
  communityId: string,
  wallet: string,
  proposers: Proposers,
  workgroupIds: string[],
): Promise<void> {
  const role = await requireMember(communityId, wallet);
  if (proposers === Proposers.Members || isAdminRole(role)) return;
  if (proposers === Proposers.Managers && (await leadsAllWorkgroups(wallet, workgroupIds))) return;
  throw new ForbiddenError(proposers === Proposers.Admins
    ? "Only admins can make this kind of proposal"
    : "Only admins and leads of the workgroups concerned can make this kind of proposal");
}

/** Whether the wallet leads every one of the given workgroups. */
export async function leadsAllWorkgroups(
  wallet: string,
  workgroupIds: string[],
): Promise<boolean> {
  const ids = [...new Set(workgroupIds)];
  if (ids.length === 0) return false;
  const led = new Set(
    rows<{ workgroup_id: string }>(
      await serviceClient()
        .from("workgroup_leads")
        .select("workgroup_id")
        .eq("wallet_address", wallet)
        .in("workgroup_id", ids),
      "load workgroup leads",
    ).map((r) => r.workgroup_id),
  );
  return ids.every((id) => led.has(id));
}
