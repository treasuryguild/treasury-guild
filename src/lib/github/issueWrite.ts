// In-app edits of a GitHub issue, pushed back to GitHub: title, body, labels
// and open/closed state go through the REST issue endpoint, the Project v2
// Status through setProjectItemStatus and bounty number fields through
// setProjectItemNumberFields. The webhook / hourly sweep then mirrors the
// result back into `tasks`, exactly as if the edit had been made on GitHub.
import "server-only";

import { UpstreamError } from "@/lib/errors";
import { installationOctokit } from "./app";
import { setProjectItemNumberFields, setProjectItemStatus } from "./projectsV2";
import { splitRepoFullName } from "./repoName";

export interface GithubIssueEdit {
  title?: string;
  /** Null clears the issue body. */
  body?: string | null;
  /** The issue's complete label set (replaces what is there). */
  labels?: string[];
  state?: "open" | "closed";
  /** Project v2 Status option name to move the item to. */
  status?: string;
  /**
   * Bounty number fields by project field name; a value is a display-unit
   * decimal string, "" clears the field.
   */
  amounts?: Record<string, string>;
}

export interface GithubIssueEditResult {
  /** The Status option the item now sits in, when a move landed; null otherwise. */
  movedToStatus: string | null;
  /** Amount field names the project has no such field for (nothing written for them). */
  missingAmountFields: string[];
}

function upstream(err: unknown): UpstreamError {
  console.error("github issue update failed", err);
  return new UpstreamError("GitHub could not be updated. Try again, or edit the issue on GitHub.");
}

/** Apply an edit to one issue (and its project item). Throws UpstreamError on any GitHub failure. */
export async function updateGithubIssue(opts: {
  installationId: number;
  repoFullName: string;
  issueNumber: number;
  /** The issue's Project v2 item; needed for a status or amount edit. */
  projectItemNodeId?: string | null;
  edit: GithubIssueEdit;
}): Promise<GithubIssueEditResult> {
  const { installationId, repoFullName, issueNumber, projectItemNodeId, edit } = opts;
  const { owner, repo } = splitRepoFullName(repoFullName);
  const result: GithubIssueEditResult = { movedToStatus: null, missingAmountFields: [] };

  if (edit.title !== undefined || edit.body !== undefined || edit.state !== undefined) {
    try {
      const octokit = await installationOctokit(installationId);
      await octokit.rest.issues.update({
        owner,
        repo,
        issue_number: issueNumber,
        ...(edit.title !== undefined ? { title: edit.title } : {}),
        ...(edit.body !== undefined ? { body: edit.body ?? "" } : {}),
        ...(edit.state !== undefined ? { state: edit.state } : {}),
      });
    } catch (err) {
      throw upstream(err);
    }
  }

  if (edit.labels !== undefined) {
    try {
      const octokit = await installationOctokit(installationId);
      if (edit.labels.length === 0) {
        await octokit.rest.issues.removeAllLabels({ owner, repo, issue_number: issueNumber });
      } else {
        await octokit.rest.issues.setLabels({
          owner,
          repo,
          issue_number: issueNumber,
          labels: edit.labels,
        });
      }
    } catch (err) {
      throw upstream(err);
    }
  }

  if (edit.status !== undefined) {
    if (!projectItemNodeId) {
      throw new UpstreamError("This issue is not on a project board, so its status cannot be changed here.");
    }
    let moved;
    try {
      moved = await setProjectItemStatus(installationId, projectItemNodeId, edit.status);
    } catch (err) {
      throw upstream(err);
    }
    if (moved.outcome === "updated" || moved.outcome === "unchanged") {
      result.movedToStatus = moved.status;
    } else if (moved.outcome === "no_option") {
      throw new UpstreamError(`The project has no "${edit.status}" column.`);
    } else {
      throw new UpstreamError("The issue's project item could not be found on GitHub.");
    }
  }

  if (edit.amounts !== undefined) {
    if (!projectItemNodeId) {
      throw new UpstreamError("This issue is not on a project board, so its bounty fields cannot be changed here.");
    }
    const values: Record<string, number | null> = {};
    for (const [field, raw] of Object.entries(edit.amounts)) {
      const trimmed = raw.trim();
      if (trimmed === "") {
        values[field] = null;
        continue;
      }
      const num = Number(trimmed);
      if (!Number.isFinite(num) || num < 0) {
        throw new UpstreamError(`Invalid amount for ${field}`);
      }
      values[field] = num;
    }
    try {
      const written = await setProjectItemNumberFields(installationId, projectItemNodeId, values);
      result.missingAmountFields = written.missing;
    } catch (err) {
      throw upstream(err);
    }
  }

  return result;
}
