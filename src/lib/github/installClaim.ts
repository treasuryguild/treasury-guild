// Whether a GitHub App installation may be bound to a community at the end of
// the install flow. GitHub's setup redirect carries `installation_id` as a
// plain query parameter that anyone can edit, so the id alone proves nothing:
// an installation another community holds is never moved, and an unclaimed
// one is accepted only while freshly created (the admin just installed it).
// The setup route also requires a user OAuth `code` whose token lists the
// installation, so a neighbour id cannot be claimed by guesswork alone.

/** How recently GitHub must have created an unclaimed installation. */
export const INSTALL_CLAIM_WINDOW_MS = 5 * 60 * 1000;

export type InstallClaim = "insert" | "update" | "taken" | "stale";

export function installationClaim(
  existing: { community_id: string } | null,
  communityId: string,
  installation: { created_at?: string | null; updated_at?: string | null },
  now: number,
): InstallClaim {
  if (existing) return existing.community_id === communityId ? "update" : "taken";
  // Only created_at: updated_at also moves when repos are added to an old
  // installation, which would reopen the claim window for anyone.
  const created = installation.created_at ? Date.parse(installation.created_at) : NaN;
  return Number.isFinite(created) && now - created <= INSTALL_CLAIM_WINDOW_MS ? "insert" : "stale";
}
