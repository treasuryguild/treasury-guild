import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import type { ApiCaller } from "@/lib/api/caller";
import { BadRequestError, ForbiddenError } from "@/lib/errors";
import { mintAccessToken, verifyAccessToken } from "@/lib/oauthServer/accessToken";
import { DRAFT_TOKEN_TTL_SECONDS, mintDraftToken, verifyDraftToken, type Draft } from "./draftToken";

const CALLER: ApiCaller = { wallet: "addr_w", scopes: ["proposals:write"], clientId: "c1", via: "oauth", grantCreatedAt: 1_790_000_000_000 };
const DRAFT: Draft = {
  action: "proposal_create",
  community: "signius",
  request: { communityId: "c-1", kind: "decision", title: "Adopt the handbook", body: "Why." },
  fingerprint: "a".repeat(64),
  rulesHash: "b".repeat(64),
};

beforeAll(() => {
  process.env.APP_URL = "http://localhost:3000";
  process.env.MCP_TOKEN_SECRET = "mcp-secret";
  process.env.CRON_SECRET = "cron-secret";
});

afterEach(() => {
  vi.useRealTimers();
});

describe("draft tokens", () => {
  it("round-trip the draft for the caller that previewed it", async () => {
    const { token, expiresAt } = await mintDraftToken(CALLER, DRAFT);
    const draft = await verifyDraftToken(token, CALLER);
    expect(draft).toMatchObject(DRAFT);
    expect(Date.parse(expiresAt) - draft.issuedAt).toBe(DRAFT_TOKEN_TTL_SECONDS * 1000);
    // Each preview is its own draft: the id the proposal will be keyed by.
    expect(draft.draftId).toMatch(/^[0-9a-f]{32}$/);
    const again = await verifyDraftToken((await mintDraftToken(CALLER, DRAFT)).token, CALLER);
    expect(again.draftId).not.toBe(draft.draftId);
  });

  it("refuse another wallet, another assistant, and a token from before a re-approval", async () => {
    const { token } = await mintDraftToken(CALLER, DRAFT);
    for (const other of [
      { ...CALLER, wallet: "addr_x" },
      { ...CALLER, clientId: "c2" },
      { ...CALLER, grantCreatedAt: CALLER.grantCreatedAt! + 1 },
      { ...CALLER, clientId: null, via: "session" as const, grantCreatedAt: undefined },
    ]) {
      await expect(verifyDraftToken(token, other)).rejects.toBeInstanceOf(ForbiddenError);
    }
  });

  it("bind a session preview to the session, not to any assistant", async () => {
    const session: ApiCaller = { wallet: "addr_w", scopes: ["proposals:write"], clientId: null, via: "session" };
    const { token } = await mintDraftToken(session, DRAFT);
    await expect(verifyDraftToken(token, session)).resolves.toMatchObject({ community: "signius" });
    await expect(verifyDraftToken(token, CALLER)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("carry their action, and refuse a confirmation of another kind", async () => {
    const { token } = await mintDraftToken(CALLER, { ...DRAFT, action: "payout_create", rulesHash: "" });
    expect(await verifyDraftToken(token, CALLER)).toMatchObject({ action: "payout_create" });
    expect(await verifyDraftToken(token, CALLER, "payout_create")).toMatchObject({ action: "payout_create" });
    await expect(verifyDraftToken(token, CALLER, "proposal_create")).rejects.toThrow("This draft is for payout_create, not proposal_create");
  });

  it("expire after fifteen minutes", async () => {
    vi.useFakeTimers({ now: new Date("2026-10-01T12:00:00Z") });
    const { token } = await mintDraftToken(CALLER, DRAFT);
    vi.setSystemTime(new Date("2026-10-01T12:14:00Z"));
    await expect(verifyDraftToken(token, CALLER)).resolves.toBeTruthy();
    vi.setSystemTime(new Date("2026-10-01T12:16:00Z"));
    await expect(verifyDraftToken(token, CALLER)).rejects.toThrow("has expired: preview it again");
  });

  it("refuse a tampered token", async () => {
    const { token } = await mintDraftToken(CALLER, DRAFT);
    const [header, payload, signature] = token.split(".");
    const claims = JSON.parse(Buffer.from(payload!, "base64url").toString());
    claims.req.title = "Something else";
    const forged = [header, Buffer.from(JSON.stringify(claims)).toString("base64url"), signature].join(".");
    await expect(verifyDraftToken(forged, CALLER)).rejects.toBeInstanceOf(BadRequestError);
    await expect(verifyDraftToken("not-a-token", CALLER)).rejects.toBeInstanceOf(BadRequestError);
  });

  it("are never access tokens, nor the reverse", async () => {
    const { token: draft } = await mintDraftToken(CALLER, DRAFT);
    expect(await verifyAccessToken(draft)).toBeNull();
    const { token: access } = await mintAccessToken({ wallet: "addr_w", clientId: "c1", scopes: ["proposals:write"], grantCreatedAt: CALLER.grantCreatedAt! });
    await expect(verifyDraftToken(access, CALLER)).rejects.toBeInstanceOf(BadRequestError);
  });
});
