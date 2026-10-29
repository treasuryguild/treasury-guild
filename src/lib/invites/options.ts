// Admin choices when creating an invite (client-safe).

/** How long a new invite lasts; `null` = never expires. */
export const INVITE_EXPIRY_DAYS = [7, 30, 90] as const;
export type InviteExpiryDays = (typeof INVITE_EXPIRY_DAYS)[number];

/** Default expiry when the admin does not pick one. */
export const DEFAULT_INVITE_EXPIRY_DAYS: InviteExpiryDays = 30;

/** Suggested caps; null in the form means unlimited. */
export const INVITE_MAX_USES_PRESETS = [10, 50, 100] as const;

/** Hard cap when max uses is set. */
export const MAX_INVITE_USES = 10_000;

/** Active (unrevoked) invites one community may hold at once. */
export const MAX_ACTIVE_INVITES_PER_COMMUNITY = 20;

/** How long an SDK signer invite stays open for signers to connect. */
export const SIGNER_DRAFT_DAYS = 7;
export const SIGNER_DRAFT_TTL_MS = SIGNER_DRAFT_DAYS * 24 * 60 * 60 * 1000;

export function inviteExpiresAt(
  expiresInDays: InviteExpiryDays | null,
  now = Date.now(),
): string | null {
  if (expiresInDays === null) return null;
  return new Date(now + expiresInDays * 24 * 60 * 60 * 1000).toISOString();
}
