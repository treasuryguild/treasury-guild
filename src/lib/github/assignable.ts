// Assignable users for a repository — the same set GitHub's issue assignee
// picker offers. Used by the in-app GitHub editor; never invents assignees.
import "server-only";

import { installationOctokit } from "./app";
import { splitRepoFullName } from "./repoName";

/** Logins that can be assigned to issues in this repo (paginated). */
export async function listAssignableLogins(
  installationId: number,
  repoFullName: string,
): Promise<string[]> {
  const { owner, repo } = splitRepoFullName(repoFullName);
  const octokit = await installationOctokit(installationId);
  const users = await octokit.paginate("GET /repos/{owner}/{repo}/assignees", {
    owner,
    repo,
    per_page: 100,
  });
  const logins: string[] = [];
  const seen = new Set<string>();
  for (const u of users) {
    const login = u.login;
    if (!login) continue;
    const key = login.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    logins.push(login);
  }
  return logins;
}
