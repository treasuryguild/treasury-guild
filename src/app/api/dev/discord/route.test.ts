import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildScenario } from "@/lib/discord/fixtures";
import type * as WebhookModule from "@/lib/discord/webhook";

const mocks = vi.hoisted(() => ({ session: vi.fn(), post: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/discord/webhook", async (importOriginal) => ({
  ...(await importOriginal<typeof WebhookModule>()),
  postDiscordWebhook: mocks.post,
}));
import { DiscordWebhookError } from "@/lib/discord/webhook";
import { POST } from "./route";

const DEV = "addr_test1dev";
const URL = "https://discord.com/api/webhooks/123/abc-DEF_9";
const context = { params: Promise.resolve({}) };
const request = (value: object) =>
  new Request("http://localhost/api/dev/discord", {
    method: "POST",
    body: JSON.stringify(value),
    headers: { "Content-Type": "application/json" },
  });

const savedEnv = process.env.DEV_WALLETS;
beforeEach(() => {
  vi.resetAllMocks();
  process.env.DEV_WALLETS = `${DEV}, addr_test1lead`;
  mocks.session.mockResolvedValue({ wallet: DEV });
  mocks.post.mockResolvedValue(undefined);
});
afterEach(() => {
  if (savedEnv === undefined) delete process.env.DEV_WALLETS;
  else process.env.DEV_WALLETS = savedEnv;
});

describe("POST /api/dev/discord", () => {
  it("refuses wallets that are not on the allowlist", async () => {
    mocks.session.mockResolvedValue({ wallet: "addr_test1stranger" });
    const res = await POST(request({ url: URL, scenario: "minimal" }), context);
    expect(res.status).toBe(403);
    expect(mocks.post).not.toHaveBeenCalled();
  });

  it("refuses everyone when the allowlist is empty", async () => {
    delete process.env.DEV_WALLETS;
    expect((await POST(request({ url: URL, scenario: "minimal" }), context)).status).toBe(403);
  });

  it("posts exactly the previewed scenario payload", async () => {
    const res = await POST(request({ url: URL, scenario: "kitchen-sink" }), context);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
    expect(mocks.post).toHaveBeenCalledTimes(1);
    expect(mocks.post.mock.calls[0]?.[0]).toBe(URL);
    expect(JSON.stringify(mocks.post.mock.calls[0]?.[1])).toBe(JSON.stringify(buildScenario("kitchen-sink")));
  });

  it.each([{ scenario: "nope" }, { url: "https://evil.com/api/webhooks/1/x" }, { url: "" }])(
    "rejects invalid input %j",
    async (change) => {
      const res = await POST(request({ url: URL, scenario: "minimal", ...change }), context);
      expect(res.status).toBe(400);
      expect(mocks.post).not.toHaveBeenCalled();
    },
  );

  it("turns a Discord refusal into a 400 with the reason", async () => {
    mocks.post.mockRejectedValue(new DiscordWebhookError("Discord webhook not found (deleted or wrong URL?)", 404, true));
    const res = await POST(request({ url: URL, scenario: "minimal" }), context);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: "Discord webhook not found (deleted or wrong URL?)" });
  });
});
