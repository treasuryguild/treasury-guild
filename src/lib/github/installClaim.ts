// Whether a GitHub App installation may be bound to a community at the end of
// the install flow. GitHub's setup redirect carries `installation_id` as a
// plain query parameter that anyone can edit, so the id alone proves nothing:
// an installation another community holds is never moved, and an unclaimed
// one is accepted only while it is fresh (the admin just installed or
// reconfigured it on GitHub), not an old installation picked by its id.

/** How recently GitHub must have created or updated an unclaimed installation. */
export const INSTALL_CLAIM_WINDOW_MS = 15 * 60 * 1000;

export type InstallClaim = "insert" | "update" | "taken" | "stale";

export function installationClaim(
  existing: { community_id: string } | null,
  communityId: string,
  installation: { created_at?: string | null; updated_at?: string | null },
  now: number,
): InstallClaim {
  if (existing) return existing.community_id === communityId ? "update" : "taken";
  const touched = [installation.created_at, installation.updated_at]
    .map((at) => (at ? Date.parse(at) : NaN))
    .filter((t) => Number.isFinite(t));
  const latest = touched.length > 0 ? Math.max(...touched) : NaN;
  return Number.isFinite(latest) && now - latest <= INSTALL_CLAIM_WINDOW_MS ? "insert" : "stale";
}
