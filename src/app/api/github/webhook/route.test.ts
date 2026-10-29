import { sign } from "@octokit/webhooks-methods";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  record: vi.fn(), processed: vi.fn(), remove: vi.fn(), repoLink: vi.fn(), issueTask: vi.fn(),
  projectItem: vi.fn(), syncIssue: vi.fn(), projectLink: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: async () => null }));
vi.mock("@/lib/db/github", () => ({
  recordWebhookDelivery: mocks.record, markWebhookProcessed: mocks.processed,
  loadRepoLink: mocks.repoLink, loadGithubIssueTask: mocks.issueTask,
}));
vi.mock("@/lib/github/disconnect", () => ({ removeInstallation: mocks.remove }));
vi.mock("@/lib/github/projectsV2", () => ({ fetchProjectItem: mocks.projectItem }));
vi.mock("@/lib/github/sync", () => ({ syncGithubIssue: mocks.syncIssue, upsertProjectLink: mocks.projectLink }));
import { POST } from "./route";

const SECRET = "github-webhook-secret";
const URL = "http://localhost/api/github/webhook";
const context = { params: Promise.resolve({}) };

async function delivery(
  event: string,
  payload: object,
  options: { id?: string; signature?: string } = {},
): Promise<Request> {
  const body = JSON.stringify(payload);
  const id = options.id ?? "d-1";
  return new Request(URL, {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-github-event": event,
      ...(id && { "x-github-delivery": id }),
      "x-hub-signature-256": options.signature ?? (await sign(SECRET, body)),
    },
  });
}

const repo = (overrides: object = {}) => ({
  id: 5, installation_id: 77, full_name: "guild/app", workgroup_id: "wg", community_id: "community",
  payable_label: "audited", import_status: "In review", paid_status: "Paid", ...overrides,
});
const issue = (overrides: object = {}) => ({
  action: "edited",
  repository: { id: 5 },
  issue: {
    number: 12, node_id: "I_12", title: "Fix the vault", body: "Details", html_url: "https://github.com/guild/app/issues/12",
    state: "open", labels: [{ name: "audited" }, { name: "bug" }], assignees: [{ login: "alice" }, { login: "bob" }],
    ...overrides,
  },
});
const projectItem = (overrides: object = {}) => ({
  action: "edited",
  installation: { id: 77 },
  projects_v2_item: { node_id: "PVTI_1", project_node_id: "PVT_1", content_type: "Issue", ...overrides },
});
const details = (fields: object = {}) => ({
  itemNodeId: "PVTI_1",
  projectId: "PVT_1",
  fields: { status: "In review", numbers: { ADA: 25, AGIX: 1.5 }, ...fields },
  issue: {
    nodeId: "I_12", number: 12, title: "Fix the vault", body: null, url: "https://github.com/guild/app/issues/12",
    repoId: 5, labels: ["Audited"], assignees: [{ login: "alice", id: 1 }],
  },
});

beforeEach(() => {
  vi.resetAllMocks();
  process.env.GITHUB_WEBHOOK_SECRET = SECRET;
  mocks.record.mockResolvedValue(true);
  mocks.processed.mockResolvedValue(undefined);
  mocks.repoLink.mockResolvedValue(repo());
  mocks.issueTask.mockResolvedValue({ id: "task", gh_status: "in review", pay_state: "none" });
  mocks.projectItem.mockResolvedValue(details());
});

describe("POST /api/github/webhook", () => {
  describe("the signature over the raw body", () => {
    it("refuses an unsigned, malformed or wrongly keyed delivery before recording anything", async () => {
      const payload = { action: "deleted", installation: { id: 77 } };
      const unsigned = new Request(URL, {
        method: "POST", body: JSON.stringify(payload), headers: { "x-github-event": "installation", "x-github-delivery": "d-1" },
      });
      const attempts = [
        unsigned,
        await delivery("installation", payload, { signature: "not-a-signature" }),
        await delivery("installation", payload, { signature: await sign("another-secret", JSON.stringify(payload)) }),
        await delivery("installation", payload, { signature: await sign(SECRET, JSON.stringify({ ...payload, installation: { id: 78 } })) }),
      ];
      for (const attempt of attempts) {
        const response = await POST(attempt, context);
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: "Invalid signature" });
      }
      expect(mocks.record).not.toHaveBeenCalled();
      expect(mocks.remove).not.toHaveBeenCalled();
    });

    it("refuses a signed delivery with no delivery id", async () => {
      const response = await POST(await delivery("installation", { action: "deleted", installation: { id: 77 } }, { id: "" }), context);
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual({ error: "Missing delivery id" });
      expect(mocks.record).not.toHaveBeenCalled();
      expect(mocks.remove).not.toHaveBeenCalled();
    });
  });

  describe("a signed body that cannot be read", () => {
    const raw = async (body: string) => new Request(URL, {
      method: "POST", body,
      headers: { "x-github-event": "issues", "x-github-delivery": "d-1", "x-hub-signature-256": await sign(SECRET, body) },
    });

    it("answers 400 for a form-encoded or non-object body, recording nothing", async () => {
      for (const body of ["payload=%7B%7D", "[1,2]", "null"]) {
        const response = await POST(await raw(body), context);
        expect(response.status).toBe(400);
      }
      expect(await (await POST(await raw("payload=%7B%7D"), context)).json())
        .toEqual({ error: "Webhook body must be JSON (content type application/json)" });
      expect(mocks.record).not.toHaveBeenCalled();
    });
  });

  describe("bookkeeping failures", () => {
    it("answers 500 when the delivery cannot be recorded, so GitHub retries; nothing is processed", async () => {
      vi.spyOn(console, "error").mockImplementation(() => undefined);
      mocks.record.mockRejectedValue(new Error("record webhook delivery: connection refused"));
      const response = await POST(await delivery("installation", { action: "deleted", installation: { id: 77 } }), context);
      expect(response.status).toBe(500);
      expect(mocks.remove).not.toHaveBeenCalled();
      expect(mocks.processed).not.toHaveBeenCalled();
    });

    it("still answers 200 for a handled event whose processed mark fails", async () => {
      const logged = vi.spyOn(console, "error").mockImplementation(() => undefined);
      mocks.processed.mockRejectedValue(new Error("mark webhook processed: timeout"));
      const response = await POST(await delivery("installation", { action: "deleted", installation: { id: 77 } }), context);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(mocks.remove).toHaveBeenCalledWith(77);
      expect(logged).toHaveBeenCalled();
    });
  });

  describe("deliveries", () => {
    it("records the delivery, drops a deleted installation and marks it processed", async () => {
      const payload = { action: "deleted", installation: { id: 77 } };
      const response = await POST(await delivery("installation", payload), context);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(mocks.record).toHaveBeenCalledWith({ deliveryId: "d-1", event: "installation", action: "deleted", payload });
      expect(mocks.remove).toHaveBeenCalledWith(77);
      expect(mocks.processed).toHaveBeenCalledWith("d-1", null);
    });

    it("does nothing for a redelivery", async () => {
      mocks.record.mockResolvedValue(false);
      const response = await POST(await delivery("installation", { action: "deleted", installation: { id: 77 } }), context);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true, duplicate: true });
      expect(mocks.remove).not.toHaveBeenCalled();
      expect(mocks.processed).not.toHaveBeenCalled();
    });

    it("records events it does not act on", async () => {
      for (const [event, payload] of [
        ["installation", { action: "created", installation: { id: 77 } }],
        ["installation_repositories", { action: "added", installation: { id: 77 } }],
        ["ping", { zen: "Keep it logically awesome." }],
      ] as const) {
        expect(await (await POST(await delivery(event, payload), context)).json()).toEqual({ ok: true });
      }
      expect(mocks.record).toHaveBeenCalledTimes(3);
      expect(mocks.record).toHaveBeenLastCalledWith(expect.objectContaining({ event: "ping", action: null }));
      expect(mocks.processed).toHaveBeenCalledTimes(3);
      expect(mocks.remove).not.toHaveBeenCalled();
      expect(mocks.syncIssue).not.toHaveBeenCalled();
    });

    it("answers 200 and stores the error when processing fails, leaving the repair to the sweep", async () => {
      mocks.syncIssue.mockRejectedValue(new Error("boom"));
      const response = await POST(await delivery("issues", issue()), context);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
      expect(mocks.processed).toHaveBeenCalledWith("d-1", "boom");
    });
  });

  describe("issues", () => {
    it("refreshes a task still in the import column, without amounts", async () => {
      expect((await POST(await delivery("issues", issue()), context)).status).toBe(200);
      expect(mocks.repoLink).toHaveBeenCalledWith(5);
      expect(mocks.issueTask).toHaveBeenCalledWith(5, 12);
      expect(mocks.syncIssue).toHaveBeenCalledWith(repo(), {
        repoId: 5, issueNumber: 12, nodeId: "I_12", title: "Fix the vault", body: "Details",
        url: "https://github.com/guild/app/issues/12", labels: ["audited", "bug"], state: "open",
        assignees: [{ login: "alice", id: 1 }, { login: "bob", id: 2 }],
      }, true);
      expect(mocks.syncIssue.mock.calls[0]![1]).not.toHaveProperty("amounts");
      expect(mocks.projectItem).not.toHaveBeenCalled();
      expect(mocks.processed).toHaveBeenCalledWith("d-1", null);
    });

    it("reports a task that lost its payable label as outside the filter", async () => {
      await POST(await delivery("issues", issue({ labels: [{ name: "bug" }], assignees: undefined })), context);
      expect(mocks.syncIssue).toHaveBeenCalledWith(
        repo(), expect.objectContaining({ labels: ["bug"], assignees: [] }), false,
      );
    });

    it("still mirrors a settled task that sits in another column", async () => {
      for (const pay_state of ["queued", "paid", "reconciled"]) {
        mocks.issueTask.mockResolvedValue({ id: "task", gh_status: "Paid", pay_state });
        await POST(await delivery("issues", issue()), context);
      }
      expect(mocks.syncIssue).toHaveBeenCalledTimes(3);
      expect(mocks.syncIssue).toHaveBeenLastCalledWith(repo(), expect.objectContaining({ issueNumber: 12 }), false);
    });

    it("ignores an unmapped repo, an issue never imported and an unsettled task outside the import column", async () => {
      mocks.repoLink.mockResolvedValueOnce(null);
      await POST(await delivery("issues", issue()), context);
      expect(mocks.issueTask).not.toHaveBeenCalled();

      mocks.issueTask.mockResolvedValueOnce(null);
      await POST(await delivery("issues", issue()), context);

      for (const gh_status of ["Backlog", null]) {
        mocks.issueTask.mockResolvedValueOnce({ id: "task", gh_status, pay_state: "payable" });
        await POST(await delivery("issues", issue()), context);
      }
      expect(mocks.syncIssue).not.toHaveBeenCalled();
      expect(mocks.processed).toHaveBeenCalledTimes(4);
      expect(mocks.processed).toHaveBeenLastCalledWith("d-1", null);
    });
  });

  describe("projects_v2_item", () => {
    it("follows the sparse payload up, registers the board and syncs the issue with its amounts", async () => {
      expect((await POST(await delivery("projects_v2_item", projectItem()), context)).status).toBe(200);
      expect(mocks.projectItem).toHaveBeenCalledWith(77, "PVTI_1");
      expect(mocks.repoLink).toHaveBeenCalledWith(5);
      expect(mocks.projectLink).toHaveBeenCalledWith("PVT_1", 77, "wg");
      expect(mocks.syncIssue).toHaveBeenCalledWith(repo(), {
        repoId: 5, issueNumber: 12, nodeId: "I_12", title: "Fix the vault", body: null,
        url: "https://github.com/guild/app/issues/12", labels: ["Audited"], assignees: [{ login: "alice", id: 1 }],
        projectItemNodeId: "PVTI_1", projectStatus: "In review", amounts: { ADA: "25", AGIX: "1.5" },
      }, true);
      expect(mocks.processed).toHaveBeenCalledWith("d-1", null);
    });

    it("sends null amounts when the item has no number fields, and false outside the import column", async () => {
      mocks.projectItem.mockResolvedValue(details({ status: "Backlog", numbers: {} }));
      await POST(await delivery("projects_v2_item", projectItem()), context);
      expect(mocks.syncIssue).toHaveBeenCalledWith(
        repo(), expect.objectContaining({ projectStatus: "Backlog", amounts: null }), false,
      );
      expect(mocks.projectLink).toHaveBeenCalledWith("PVT_1", 77, "wg");
    });

    it("registers no board for a repo without a workgroup", async () => {
      mocks.repoLink.mockResolvedValue(repo({ workgroup_id: null }));
      await POST(await delivery("projects_v2_item", projectItem()), context);
      expect(mocks.projectLink).not.toHaveBeenCalled();
      expect(mocks.syncIssue).toHaveBeenCalledTimes(1);
    });

    it("ignores items that are not issues, items GitHub no longer describes and unmapped repos", async () => {
      await POST(await delivery("projects_v2_item", projectItem({ content_type: "DraftIssue" })), context);
      expect(mocks.projectItem).not.toHaveBeenCalled();

      mocks.projectItem.mockResolvedValueOnce(null);
      await POST(await delivery("projects_v2_item", projectItem()), context);
      mocks.projectItem.mockResolvedValueOnce({ ...details(), issue: null });
      await POST(await delivery("projects_v2_item", projectItem()), context);
      expect(mocks.repoLink).not.toHaveBeenCalled();

      mocks.repoLink.mockResolvedValueOnce(null);
      await POST(await delivery("projects_v2_item", projectItem()), context);
      expect(mocks.projectLink).not.toHaveBeenCalled();
      expect(mocks.syncIssue).not.toHaveBeenCalled();
      expect(mocks.processed).toHaveBeenCalledTimes(4);
    });
  });
});
