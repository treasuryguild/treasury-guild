import { beforeEach, describe, expect, it, vi } from "vitest";
import type * as Caller from "@/lib/api/caller";
import { UnauthorizedError } from "@/lib/errors";

// The write previews and draft_confirm over REST: one-line v1PostRoute wirings.
// `run` of each real endpoint is replaced, so its real scope and input schema
// still apply; v1PostRoute's own checks are in proposals/preview/route.test.ts.

const mocks = vi.hoisted(() => ({ caller: vi.fn(), rateLimit: vi.fn() }));
vi.mock("@/lib/api/caller", async (importOriginal) => ({
  ...(await importOriginal<typeof Caller>()),
  resolveApiCaller: mocks.caller,
}));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.rateLimit }));

import { previewCallCreate, previewCallFinalize } from "@/lib/api/v1/callWrite";
import { confirmDraft } from "@/lib/api/v1/drafts";
import type { ApiEndpoint } from "@/lib/api/v1/endpoint";
import { previewPayout } from "@/lib/api/v1/payoutWrite";
import { previewProposalWithdraw } from "@/lib/api/v1/proposalWithdraw";
import { previewTaskSave } from "@/lib/api/v1/taskWrite";
import { POST as finalizePOST } from "./communities/[community]/calls/finalize/preview/route";
import { POST as callPOST } from "./communities/[community]/calls/preview/route";
import { POST as payoutPOST } from "./communities/[community]/payouts/preview/route";
import { POST as withdrawPOST } from "./communities/[community]/proposals/withdraw/preview/route";
import { POST as taskPOST } from "./communities/[community]/tasks/preview/route";
import { POST as confirmPOST } from "./drafts/confirm/route";

const CALLER = { wallet: "addr_w", scopes: ["proposals:write", "tasks:write", "payouts:write"], clientId: "c1", via: "oauth" };
const endpoints = { previewPayout, previewProposalWithdraw, previewTaskSave, previewCallCreate, previewCallFinalize, confirmDraft } as Record<string, ApiEndpoint>;
const runs = {} as Record<string, ReturnType<typeof vi.fn>>;

beforeEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  mocks.caller.mockResolvedValue(CALLER);
  mocks.rateLimit.mockResolvedValue(undefined);
  for (const [name, endpoint] of Object.entries(endpoints)) {
    runs[name] = vi.spyOn(endpoint, "run").mockResolvedValue({ endpoint: name }) as unknown as ReturnType<typeof vi.fn>;
  }
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const post = (handler: (req: Request, ctx: any) => Promise<Response>, path: string, body: unknown, params: Record<string, string>, headers: Record<string, string> = {}) =>
  handler(new Request(`http://localhost${path}`, {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body: JSON.stringify(body),
  }), { params: Promise.resolve(params) } as never);

const previews = [
  { segment: "payouts/preview", handler: payoutPOST, name: "previewPayout", body: { tasks: [12] }, scope: "payouts:write" },
  { segment: "proposals/withdraw/preview", handler: withdrawPOST, name: "previewProposalWithdraw", body: { proposal: 7 }, scope: "proposals:write" },
  { segment: "tasks/preview", handler: taskPOST, name: "previewTaskSave", body: { task: 12, title: "Logo" }, scope: "tasks:write" },
  {
    segment: "calls/preview", handler: callPOST, name: "previewCallCreate", scope: "tasks:write",
    body: { workgroup: "Design", provider: "manual", title: "Town hall", startsAt: "2026-10-08T17:00:00Z", endsAt: "2026-10-08T18:00:00Z", reward: { ADA: "20" } },
  },
  { segment: "calls/finalize/preview", handler: finalizePOST, name: "previewCallFinalize", body: { call: "77777777-7777-4777-8777-777777777777" }, scope: "tasks:write" },
] as const;

describe("write preview routes", () => {
  it.each(previews)("POST /api/v1/communities/[community]/$segment runs $name with the body and the path's community", async ({ segment, handler, name, body }) => {
    const res = await post(handler, `/api/v1/communities/signius/${segment}`, { ...body, community: "other" }, { community: "signius" });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ endpoint: name });
    expect(runs[name]).toHaveBeenCalledWith(CALLER, expect.objectContaining({ community: "signius" }));
    expect(mocks.rateLimit).toHaveBeenCalledWith("agentApi", "addr_w");
    for (const [other, run] of Object.entries(runs)) if (other !== name) expect(run, other).not.toHaveBeenCalled();
  });

  it.each(previews)("$name needs $scope, a caller, and a same-site request", async ({ segment, handler, name, body, scope }) => {
    const call = (headers: Record<string, string> = {}) => post(handler, `/api/v1/communities/signius/${segment}`, body, { community: "signius" }, headers);
    mocks.caller.mockResolvedValueOnce({ ...CALLER, scopes: CALLER.scopes.filter((s) => s !== scope) });
    expect((await call()).status).toBe(403);
    mocks.caller.mockRejectedValueOnce(new UnauthorizedError());
    expect((await call()).status).toBe(401);
    expect((await call({ "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect(runs[name]).not.toHaveBeenCalled();
  });
});

describe("POST /api/v1/drafts/confirm", () => {
  it("runs draft_confirm with the token, for a caller holding any write scope", async () => {
    mocks.caller.mockResolvedValue({ ...CALLER, scopes: ["tasks:write"] });
    const res = await post(confirmPOST, "/api/v1/drafts/confirm", { draftToken: "t" }, {});
    expect(res.status).toBe(200);
    expect(runs.confirmDraft).toHaveBeenCalledWith(expect.objectContaining({ wallet: "addr_w" }), { draftToken: "t" });
  });

  it("refuses a caller with no write scope, a missing token and a cross-site request", async () => {
    mocks.caller.mockResolvedValueOnce({ ...CALLER, scopes: ["communities:read"] });
    expect((await post(confirmPOST, "/api/v1/drafts/confirm", { draftToken: "t" }, {})).status).toBe(403);
    expect((await post(confirmPOST, "/api/v1/drafts/confirm", {}, {})).status).toBe(400);
    expect((await post(confirmPOST, "/api/v1/drafts/confirm", { draftToken: "t" }, {}, { "sec-fetch-site": "cross-site" })).status).toBe(403);
    expect(runs.confirmDraft).not.toHaveBeenCalled();
  });
});
