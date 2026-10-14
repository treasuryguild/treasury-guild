// The GitHub sync sweep: re-sync linked repos never synced or stale, because
// webhooks are not the source of truth. Run by the Netlify schedule through
// /api/cron/github-sync and by hand from the /dev tools page.
import "server-only";

import { staleRepoLinks } from "@/lib/db/github";
import { errorMessage } from "@/lib/errors";
import { fullSyncRepo } from "@/lib/github/sync";

const STALE_HOURS = 6;
const BATCH = 5;

// A type alias (not an interface) so the route wrapper's JSON type accepts it.
export type GithubSyncSweepResult = {
  /** Per repo full name: "synced N, deleted M" or the failure message. */
  results: Record<string, string>;
};

export async function runGithubSyncSweep(): Promise<GithubSyncSweepResult> {
  const staleBefore = new Date(Date.now() - STALE_HOURS * 3600_000).toISOString();
  const repos = await staleRepoLinks(BATCH, staleBefore);

  const results: GithubSyncSweepResult["results"] = {};
  for (const repo of repos) {
    try {
      const { synced, deleted } = await fullSyncRepo(repo);
      results[repo.full_name] = `synced ${synced}, deleted ${deleted}`;
    } catch (err) {
      results[repo.full_name] = errorMessage(err, "sync failed");
    }
  }
  return { results };
}
