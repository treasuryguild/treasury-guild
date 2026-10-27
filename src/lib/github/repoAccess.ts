// Resolve a repository id against a community's GitHub App installations
// (Contents / Metadata). Shared by workgroup repo linking and the governance
// archive-repo picker (migration 0067).
import "server-only";

import { communityInstallations } from "@/lib/db/github";
import { BadRequestError, UpstreamError } from "@/lib/errors";
import { installationOctokit } from "./app";

export interface AccessibleRepo {
  installationId: number;
  fullName: string;
}

/**
 * The installation that can see `repoId` for this community, and the repo's
 * full name as GitHub returns it. 400 when no community installation reaches it.
 */
export async function resolveCommunityRepo(
  communityId: string, repoId: number,
): Promise<AccessibleRepo> {
  const installations = await communityInstallations(communityId);
  if (installations.length === 0) {
    throw new BadRequestError("GitHub App not installed for this community");
  }
  let lastUpstream: unknown;
  for (const installation of installations) {
    try {
      const fullName = await installationRepoName(Number(installation.installation_id), repoId);
      return { installationId: Number(installation.installation_id), fullName };
    } catch (err) {
      if (err instanceof BadRequestError) continue;
      lastUpstream = err;
    }
  }
  if (lastUpstream) {
    console.error(`looking up repo ${repoId} for community ${communityId} failed`, lastUpstream);
    throw new UpstreamError("GitHub repository lookup failed");
  }
  throw new BadRequestError("This repository is not available to this community's GitHub installation");
}

/** The repo's full name as the installation sees it; 400 when it cannot see it. */
export async function installationRepoName(installationId: number, repoId: number): Promise<string> {
  const octokit = await installationOctokit(installationId);
  try {
    const { data } = await octokit.request("GET /repositories/{repository_id}", {
      repository_id: repoId,
    });
    return (data as { full_name: string }).full_name;
  } catch (err) {
    const status = (err as { status?: number }).status;
    if (status === 404 || status === 403) {
      throw new BadRequestError("This repository is not available to this community's GitHub installation");
    }
    console.error(`looking up repo ${repoId} for installation ${installationId} failed`, err);
    throw new UpstreamError("GitHub repository lookup failed");
  }
}
