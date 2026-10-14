import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Caller from "@/lib/api/caller";
import type * as ProposalWrite from "@/lib/api/v1/proposalWrite";
import { UnauthorizedError } from "@/lib/errors";

// Wiring only (and v1PostRoute's own checks): the endpoints are tested in
// src/lib/api/v1/proposalWrite.test.ts. The real scopes and input schemas stay.
const mocks = vi.hoisted(() => ({ caller: vi.fn(), rateLimit: vi.fn(), preview: vi.fn(), create: vi.fn() }));
vi.mock("@/lib/api/caller", async (importOriginal) => ({
  ...(await importOriginal<typeof Caller>()),
  resolveApiCaller: mocks.caller,
}));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.rateLimit }));
vi.mock("@/lib/api/v1/proposalWrite", async (importOriginal) => {
  const real = await importOriginal<typeof ProposalWrite>();
  return {
    ...real,
    previewProposal: { ...real.previewProposal, run: mocks.preview },
    createProposalFromDraft: { ...real.createProposalFromDraft, run: mocks.create },
  };
});
import { POST as createPOST } from "../create/route";
import { POST } from "./route";

const ctx = { params: Promise.resolve({ community: "signius" }) };
const WRITER = { wallet: "addr_w", scopes: ["communities:read", "proposals:write"], clientId: "c1", via: "oauth" };
const post = (handler: typeof POST, body: unknown, headers: Record<string, string> = {}) =>
  handler(new Request("http://localhost/api/v1/communities/signius/proposals/preview", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }), ctx);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.caller.mockResolvedValue(WRITER);
  mocks.rateLimit.mockResolvedValue(undefined);
  mocks.preview.mockResolvedValue({ draftToken: "t" });
  mocks.create.mockResolvedValue({ created: true });
});

describe("POST /api/v1/communities/[community]/proposals/preview and /create", () => {
  it("runs the preview with the JSON body and the path's community", async () => {
    const res = await post(POST, { kind: "decision", title: "Adopt", community: "other" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ draftToken: "t" });
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(mocks.rateLimit).toHaveBeenCalledWith("agentApi", "addr_w");
    expect(mocks.preview).toHaveBeenCalledExactlyOnceWith(WRITER, { community: "signius", kind: "decision", title: "Adopt", body: "" });
  });

  it("runs the confirmation with the draft token only", async () => {
    const res = await post(createPOST, { draftToken: "t", title: "ignored" });
    expect(res.status).toBe(200);
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith(WRITER, { draftToken: "t", community: "signius" });
  });

  it("refuses a request another site's page sent, before resolving the caller", async () => {
    const res = await post(createPOST, { draftToken: "t" }, { "sec-fetch-site": "cross-site" });
    expect(res.status).toBe(403);
    expect(mocks.caller).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });

  it("answers 403 without the write scope, 401 without a caller and 400 for a bad body", async () => {
    mocks.caller.mockResolvedValueOnce({ ...WRITER, scopes: ["communities:read"] });
    expect((await post(POST, { kind: "decision", title: "Adopt" })).status).toBe(403);
    mocks.caller.mockRejectedValueOnce(new UnauthorizedError());
    expect((await post(POST, { kind: "decision", title: "Adopt" })).status).toBe(401);
    expect((await post(POST, { kind: "poll", title: "Adopt" })).status).toBe(400);
    expect((await post(createPOST, [])).status).toBe(400);
    expect(mocks.preview).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});
