// In-app creates and edits of a GitHub issue, pushed back to GitHub: create
// opens an issue via REST; edits push title, body, labels, open/closed state
// and assignees through the REST issue endpoint, Project v2 Status through
// setProjectItemStatus and bounty number fields through setProjectItemNumberFields.
// The webhook / hourly sweep then mirrors the result into `tasks`, exactly as
// if the change had been made on GitHub.
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
  /** Complete assignee login set (replaces what is there); [] clears. */
  assignees?: string[];
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

function upstream(err: unknown, action: "create" | "update" = "update"): UpstreamError {
  console.error(action === "create" ? "github issue create failed" : "github issue update failed", err);
  return new UpstreamError(
    action === "create"
      ? "GitHub could not create the issue. Try again, or open it on GitHub."
      : "GitHub could not be updated. Try again, or edit the issue on GitHub.",
  );
}

export interface CreatedGithubIssue {
  number: number;
  /** GraphQL node id — contentId for addProjectV2ItemById. */
  nodeId: string;
  htmlUrl: string;
  title: string;
}

/** Open a new issue in the linked repository. Throws UpstreamError on any GitHub failure. */
export async function createGithubIssue(opts: {
  installationId: number;
  repoFullName: string;
  title: string;
}): Promise<CreatedGithubIssue> {
  const { owner, repo } = splitRepoFullName(opts.repoFullName);
  try {
    const octokit = await installationOctokit(opts.installationId);
    const { data } = await octokit.rest.issues.create({
      owner,
      repo,
      title: opts.title,
    });
    if (!data.node_id) {
      throw new Error("GitHub create response missing node_id");
    }
    return {
      number: data.number,
      nodeId: data.node_id,
      htmlUrl: data.html_url,
      title: data.title,
    };
  } catch (err) {
    if (err instanceof UpstreamError) throw err;
    throw upstream(err, "create");
  }
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

  if (
    edit.title !== undefined || edit.body !== undefined || edit.state !== undefined ||
    edit.assignees !== undefined
  ) {
    try {
      const octokit = await installationOctokit(installationId);
      await octokit.rest.issues.update({
        owner,
        repo,
        issue_number: issueNumber,
        ...(edit.title !== undefined ? { title: edit.title } : {}),
        ...(edit.body !== undefined ? { body: edit.body ?? "" } : {}),
        ...(edit.state !== undefined ? { state: edit.state } : {}),
        ...(edit.assignees !== undefined ? { assignees: edit.assignees } : {}),
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
