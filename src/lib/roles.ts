// Role predicates shared by client pages and server routes.

import { Proposers, Role } from "@/lib/constants";

export function isAdminRole(role: string | null | undefined): boolean {
  return role === Role.Owner || role === Role.Admin;
}

export function isOwnerRole(role: string | null | undefined): boolean {
  return role === Role.Owner;
}

/** Mirrors the server's workgroup-manager rule: an admin, or a lead of the workgroup. */
export function managesWorkgroup(
  roles: { isAdmin: boolean; ledWorkgroupIds: ReadonlySet<string> },
  workgroupId: string,
): boolean {
  return roles.isAdmin || roles.ledWorkgroupIds.has(workgroupId);
}

/** Mirrors the server's treasury-actor rule: a base signer of that treasury only. */
export function actsForTreasury(
  roles: { signerTreasuryIds: ReadonlySet<string> },
  treasuryId: string,
): boolean {
  return roles.signerTreasuryIds.has(treasuryId);
}

/** Mirrors requirePathBuilder for the recovery path: a recovery signer of that treasury only. */
export function mayRecover(
  roles: { recoveryTreasuryIds: ReadonlySet<string> },
  treasuryId: string,
): boolean {
  return roles.recoveryTreasuryIds.has(treasuryId);
}

/**
 * Mirrors requireProposer: any member, admins, or "managers" (admins and
 * leads of every workgroup the proposal concerns; none concerned = admins).
 */
export function mayPropose(
  roles: { isAdmin: boolean; ledWorkgroupIds: ReadonlySet<string> },
  proposers: Proposers,
  workgroupIds: readonly string[],
): boolean {
  if (proposers === Proposers.Members || roles.isAdmin) return true;
  return proposers === Proposers.Managers && workgroupIds.length > 0 && workgroupIds.every((id) => roles.ledWorkgroupIds.has(id));
}
