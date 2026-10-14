import { describe, expect, it, vi } from "vitest";
import type { DiscordWebhookPayload } from "./payoutMessage";
import { DiscordWebhookError, postDiscordWebhook, webhookUrlHint, type FetchLike } from "./webhook";

const URL_ = "https://discord.com/api/webhooks/123456789012345678/abcDEF-ghi_JKL9876";
const payload: DiscordWebhookPayload = { username: "Guild Vault", embeds: [] };

const answering = (status: number, body = "") =>
  vi.fn<FetchLike>(async () => new Response(status === 204 ? null : body, { status }));

async function failure(fetchImpl: FetchLike): Promise<DiscordWebhookError> {
  try {
    await postDiscordWebhook(URL_, payload, fetchImpl);
  } catch (err) {
    expect(err).toBeInstanceOf(DiscordWebhookError);
    return err as DiscordWebhookError;
  }
  throw new Error("expected postDiscordWebhook to throw");
}

describe("webhookUrlHint", () => {
  it("shows the id and the last four characters of the token only", () => {
    expect(webhookUrlHint(URL_)).toBe("…/webhooks/123456789012345678/••••9876");
    expect(webhookUrlHint(URL_)).not.toContain("abcDEF");
  });

  it("works on the legacy discordapp.com host", () => {
    expect(webhookUrlHint("https://discordapp.com/api/webhooks/42/tok-en_1234")).toBe("…/webhooks/42/••••1234");
  });

  it("shows nothing of a URL it cannot read", () => {
    const blank = "…/webhooks/••••";
    expect(webhookUrlHint("")).toBe(blank);
    expect(webhookUrlHint("https://example.com/hook/secret")).toBe(blank);
    expect(webhookUrlHint("https://discord.com/api/webhooks/not-numeric/secrettoken")).toBe(blank);
    expect(webhookUrlHint(`${URL_}?wait=true`)).toBe(blank);
    expect(webhookUrlHint(`${URL_}/slack`)).toBe(blank);
  });

  it("shows a token shorter than four characters whole", () => {
    expect(webhookUrlHint("https://discord.com/api/webhooks/1/ab")).toBe("…/webhooks/1/••••ab");
  });
});

describe("postDiscordWebhook", () => {
  it("posts the payload as JSON and resolves on 204", async () => {
    const fetchImpl = answering(204);
    await expect(postDiscordWebhook(URL_, payload, fetchImpl)).resolves.toBeUndefined();
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    const [url, init] = fetchImpl.mock.calls[0]!;
    expect(url).toBe(URL_);
    expect(init.method).toBe("POST");
    expect(init.headers).toEqual({ "content-type": "application/json" });
    expect(JSON.parse(init.body as string)).toEqual(payload);
  });

  it("resolves on any 2xx", async () => {
    await expect(postDiscordWebhook(URL_, payload, answering(200, "{}"))).resolves.toBeUndefined();
  });

  it("treats 429 as transient", async () => {
    const err = await failure(answering(429, '{"message":"You are being rate limited.","retry_after":1.2}'));
    expect(err.status).toBe(429);
    expect(err.permanent).toBe(false);
    expect(err.message).toBe('Discord answered 429: {"message":"You are being rate limited.","retry_after":1.2}');
    expect(err.name).toBe("DiscordWebhookError");
  });

  it.each([401, 403, 404])("treats %i as a dead webhook: permanent", async (status) => {
    const err = await failure(answering(status, '{"message":"Unknown Webhook","code":10015}'));
    expect(err.status).toBe(status);
    expect(err.permanent).toBe(true);
    expect(err.message).toBe('Discord webhook not found (deleted or wrong URL?): {"message":"Unknown Webhook","code":10015}');
  });

  it("treats a rejected payload (400) as permanent", async () => {
    const err = await failure(answering(400, "bad embed"));
    expect(err.status).toBe(400);
    expect(err.permanent).toBe(true);
    expect(err.message).toBe("Discord answered 400: bad embed");
  });

  it.each([500, 502, 503])("treats %i as transient", async (status) => {
    const err = await failure(answering(status));
    expect(err.status).toBe(status);
    expect(err.permanent).toBe(false);
    expect(err.message).toBe(`Discord answered ${status}`);
  });

  it("cuts the body excerpt at 200 characters", async () => {
    const err = await failure(answering(500, "x".repeat(500)));
    expect(err.message).toBe(`Discord answered 500: ${"x".repeat(200)}`);
  });

  it("survives a body that cannot be read", async () => {
    const res = { ok: false, status: 404, text: () => Promise.reject(new Error("stream broke")) } as unknown as Response;
    const err = await failure(async () => res);
    expect(err.message).toBe("Discord webhook not found (deleted or wrong URL?)");
    expect(err.permanent).toBe(true);
  });

  it("maps a network failure to a transient error with no status", async () => {
    const err = await failure(async () => {
      throw new Error("ECONNRESET");
    });
    expect(err.status).toBeNull();
    expect(err.permanent).toBe(false);
    expect(err.message).toBe("Discord unreachable: ECONNRESET");
  });

  it("never puts the webhook URL in an error", async () => {
    const dead = await failure(answering(404, "gone"));
    const down = await failure(async () => {
      throw new Error("timeout");
    });
    expect(dead.message).not.toContain("abcDEF");
    expect(down.message).not.toContain("abcDEF");
  });
});
