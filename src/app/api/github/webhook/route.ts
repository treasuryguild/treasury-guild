import { verify } from "@octokit/webhooks-methods";
import { publicRoute } from "@/lib/api/route";
import { SETTLED_PAY_STATES } from "@/lib/constants";
import {
  loadGithubIssueTask,
  loadRepoLink,
  markWebhookProcessed,
  recordWebhookDelivery,
} from "@/lib/db/github";
import { githubWebhookSecret } from "@/lib/env.server";
import { BadRequestError, errorMessage, UnauthorizedError } from "@/lib/errors";
import { removeInstallation } from "@/lib/github/disconnect";
import { fetchProjectItem } from "@/lib/github/projectsV2";
import { syncGithubIssue, upsertProjectLink } from "@/lib/github/sync";
import { matchesImportFilter } from "@/lib/github/syncRules";

// Fast path only (<10s Netlify budget): verify + upsert + at most one GraphQL
// follow-up. The hourly cron sweep repairs anything that errors here.
export const POST = publicRoute(async (req) => {
  const rawBody = await req.text();
  const signature = req.headers.get("x-hub-signature-256") ?? "";
  const event = req.headers.get("x-github-event") ?? "";
  const deliveryId = req.headers.get("x-github-delivery") ?? "";

  // verify() throws on a missing or malformed header; either way it is an
  // unsigned request (401), not a server error.
  const signed = signature !== "" &&
    (await verify(githubWebhookSecret(), rawBody, signature).catch(() => false));
  if (!signed) throw new UnauthorizedError("Invalid signature");
  if (!deliveryId) throw new BadRequestError("Missing delivery id");

  const payload = parsePayload(rawBody);
  const action = (payload.action as string) ?? null;

  // Idempotency: X-GitHub-Delivery is unique per delivery; redeliveries no-op.
  if (!(await recordWebhookDelivery({ deliveryId, event, action, payload }))) {
    return { ok: true, duplicate: true };
  }

  let error: string | null = null;
  try {
    await processEvent(event, action, payload);
  } catch (err) {
    error = errorMessage(err, String(err));
  }

  // The event was handled: a failure to mark it must not answer 500, or a
  // redelivery would be dropped as a duplicate of a row never marked.
  await markWebhookProcessed(deliveryId, error).catch((err) =>
    console.error(`marking webhook ${deliveryId} processed failed`, err),
  );

  return { ok: true };
});

/** The JSON body; a signed body in another format (a form-encoded hook) is a 400. */
function parsePayload(rawBody: string): Record<string, unknown> {
  let payload: unknown;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    throw new BadRequestError("Webhook body must be JSON (content type application/json)");
  }
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) {
    throw new BadRequestError("Webhook body must be a JSON object");
  }
  return payload as Record<string, unknown>;
}

async function processEvent(
  event: string,
  action: string | null,
  payload: Record<string, unknown>,
): Promise<void> {
  if (event === "installation" && action === "deleted") {
    const installation = payload.installation as { id: number };
    await removeInstallation(installation.id);
    return;
  }

  if (event === "installation_repositories") {
    // repos added/removed: nothing automatic — mapping is explicit in settings
    return;
  }

  if (event === "issues") {
    const issue = payload.issue as {
      number: number;
      node_id: string;
      title: string;
      body: string | null;
      html_url: string;
      state: string;
      labels: { name: string }[];
      assignees?: { login: string }[];
    };
    const repository = payload.repository as { id: number };
    const repo = await loadRepoLink(repository.id);
    if (!repo) return; // unmapped repo

    // Issue events carry no project data. Only refresh tasks that are still
    // in the import column, plus settled ones (paid issues sit in the Paid
    // column and only ever get their text/labels mirrored); new imports need
    // project status and come via the projects_v2_item webhook or the sweep.
    const existing = await loadGithubIssueTask(repository.id, issue.number);
    if (!existing) return;
    const settled = SETTLED_PAY_STATES.includes(existing.pay_state);
    if (
      !settled &&
      (existing.gh_status ?? "").toLowerCase() !== repo.import_status.toLowerCase()
    ) {
      return;
    }

    const labels = (issue.labels ?? []).map((l) => l.name);
    await syncGithubIssue(
      repo,
      {
        repoId: repository.id,
        issueNumber: issue.number,
        nodeId: issue.node_id,
        title: issue.title,
        body: issue.body,
        url: issue.html_url,
        labels,
        state: issue.state,
        assigneeLogins: (issue.assignees ?? []).map((a) => a.login),
        // amounts intentionally omitted: label churn must not clobber them
      },
      matchesImportFilter(repo, labels, existing.gh_status),
    );
    return;
  }

  if (event === "projects_v2_item") {
    // Sparse payload: node ids only — one GraphQL follow-up for the details.
    const item = payload.projects_v2_item as {
      node_id: string;
      project_node_id: string;
      content_type: string;
    };
    if (item.content_type !== "Issue") return;

    const installation = payload.installation as { id: number };
    const details = await fetchProjectItem(installation.id, item.node_id);
    if (!details?.issue) return;

    const repo = await loadRepoLink(details.issue.repoId);
    if (!repo) return;

    // Register the board for the live view regardless of the import filter —
    // non-payable items still tell us which project feeds this workgroup.
    if (repo.workgroup_id) {
      await upsertProjectLink(
        item.project_node_id,
        installation.id,
        repo.workgroup_id,
      );
    }

    const amounts = Object.fromEntries(
      Object.entries(details.fields.numbers).map(([k, v]) => [k, String(v)]),
    );
    await syncGithubIssue(
      repo,
      {
        repoId: details.issue.repoId,
        issueNumber: details.issue.number,
        nodeId: details.issue.nodeId,
        title: details.issue.title,
        body: details.issue.body,
        url: details.issue.url,
        labels: details.issue.labels,
        assigneeLogins: details.issue.assigneeLogins,
        projectItemNodeId: details.itemNodeId,
        projectStatus: details.fields.status,
        amounts: Object.keys(amounts).length > 0 ? amounts : null,
      },
      matchesImportFilter(repo, details.issue.labels, details.fields.status),
    );
  }
}
