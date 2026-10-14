import { decodeJwt } from "jose";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiCaller } from "@/lib/api/caller";
import { BadRequestError, ConflictError, ForbiddenError } from "@/lib/errors";
import { mintDraftToken, type DraftAction } from "@/lib/mcp/draftToken";

const mocks = vi.hoisted(() => ({
  community: vi.fn(),
  role: vi.fn(),
  workgroups: vi.fn(),
  checkCreate: vi.fn(),
  create: vi.fn(),
  findByDraft: vi.fn(),
  loadForManager: vi.fn(),
  plan: vi.fn(),
  finalize: vi.fn(),
  numbers: vi.fn(),
}));
vi.mock("@/lib/db/communities", () => ({ requireCommunityBySlug: mocks.community }));
vi.mock("@/lib/authz", () => ({ memberRole: mocks.role }));
vi.mock("@/lib/db/workgroups", () => ({ listCommunityWorkgroups: mocks.workgroups }));
vi.mock("@/lib/calls/create", () => ({ checkCreateCall: mocks.checkCreate, createCall: mocks.create }));
vi.mock("@/lib/calls/access", () => ({ loadCallForManager: mocks.loadForManager }));
vi.mock("@/lib/calls/finalize", () => ({ planFinalize: mocks.plan, finalizeReady: mocks.finalize }));
vi.mock("@/lib/db/calls", () => ({ findCallByDraft: mocks.findByDraft }));
vi.mock("@/lib/db/tasks", () => ({ taskNumbers: mocks.numbers }));

import { previewCallCreate, previewCallFinalize } from "./callWrite";
import { confirmDraft } from "./drafts";
import { callEndpoint } from "./endpoint";

const caller: ApiCaller = { wallet: "addr_w", scopes: ["tasks:write"], clientId: "c1", via: "oauth", grantCreatedAt: 1 };
const COMMUNITY = { id: "c1", slug: "signius", name: "Signius", network: 0, visibility: "private" };
const WGID = "22222222-2222-4222-8222-222222222222";
const CALL_ID = "77777777-7777-4777-8777-777777777777";
const CALL = {
  id: CALL_ID, community_id: "c1", workgroup_id: WGID, title: "Town hall", starts_at: "2026-10-08T17:00:00Z",
  amounts: { ADA: "20" }, min_snapshots: 1, min_minutes: 0,
};
const attendee = (id: string, wallet: string | null) => ({ id, display_name: `Person ${id}`, wallet_address: wallet, minutes: 40, snapshots_seen: 3 });
const PLAN = {
  ready: [attendee("a1", "addr_1"), attendee("a2", "addr_2")],
  standings: { rewarded: 0, excluded: 0, "below-threshold": 1, unlinked: 1, ready: 2 },
  tasks: 1,
};
const CREATE = {
  community: "signius", workgroup: "Design", provider: "manual", title: "Town hall",
  startsAt: "2026-10-08T17:00:00Z", endsAt: "2026-10-08T18:00:00Z", reward: { ADA: "20" },
};

beforeAll(() => {
  process.env.APP_URL = "http://localhost:3000";
  process.env.MCP_TOKEN_SECRET = "mcp-secret";
  process.env.CRON_SECRET = "cron-secret";
});

beforeEach(() => {
  vi.resetAllMocks();
  mocks.community.mockResolvedValue(COMMUNITY);
  mocks.role.mockResolvedValue("member");
  mocks.workgroups.mockResolvedValue([{ id: WGID, name: "Design", kind: "native", archived_at: null, treasury_id: null }]);
  mocks.checkCreate.mockResolvedValue("c1");
  mocks.create.mockResolvedValue({ id: CALL_ID, title: "Town hall", community_id: "c1" });
  mocks.findByDraft.mockResolvedValue(null);
  mocks.loadForManager.mockResolvedValue(CALL);
  mocks.plan.mockResolvedValue(PLAN);
  mocks.finalize.mockResolvedValue({ taskIds: ["t-1"], paid: 2, remaining: 1 });
  mocks.numbers.mockResolvedValue([41]);
});

const confirm = (draftToken: string) => callEndpoint(confirmDraft, caller, { draftToken });

/** The same draft re-signed with its request changed: the fingerprint no longer matches. */
async function tampered(draftToken: string, patch: Record<string, unknown>): Promise<string> {
  const p = decodeJwt(draftToken);
  const { token } = await mintDraftToken(caller, {
    action: p.act as DraftAction,
    community: p.com as string,
    request: { ...(p.req as Record<string, unknown>), ...patch },
    fingerprint: p.fp as string,
    rulesHash: p.rh as string,
  });
  return token;
}

describe("call_create_preview", () => {
  it("checks the call as POST /api/calls does and creates nothing", async () => {
    const res = await callEndpoint(previewCallCreate, caller, CREATE);
    expect(mocks.checkCreate).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ workgroupId: WGID, provider: "manual", amounts: { ADA: "20" }, externalRef: null, minSnapshots: 1, minMinutes: 0 }),
      "addr_w",
    );
    expect(mocks.create).not.toHaveBeenCalled();
    expect(res).toMatchObject({ action: "call_create", details: { workgroup: "Design", title: "Town hall", reward: { ADA: "20" } } });
  });

  it("refuses bad times or a bad reward before checking anything", async () => {
    await expect(callEndpoint(previewCallCreate, caller, { ...CREATE, endsAt: "2026-10-08T16:00:00Z" })).rejects.toThrow("end after it starts");
    await expect(callEndpoint(previewCallCreate, caller, { ...CREATE, startsAt: "tomorrow" })).rejects.toBeInstanceOf(BadRequestError);
    await expect(callEndpoint(previewCallCreate, caller, { ...CREATE, reward: { ADA: "-1" } })).rejects.toBeInstanceOf(BadRequestError);
    expect(mocks.checkCreate).not.toHaveBeenCalled();
  });

  it("creates the call once, keyed by the draft", async () => {
    const { draftToken } = await callEndpoint(previewCallCreate, caller, CREATE);
    const res = await confirm(draftToken);
    expect(mocks.create).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ title: "Town hall" }), "addr_w", { agentDraftId: expect.stringMatching(/^[0-9a-f]{32}$/), communityId: "c1" },
    );
    expect(res).toMatchObject({ action: "call_create", created: true, callId: CALL_ID, url: `http://localhost:3000/c/signius/calls/${CALL_ID}` });
    mocks.findByDraft.mockResolvedValue({ id: CALL_ID, title: "Town hall", community_id: "c1" });
    expect(await confirm(draftToken)).toMatchObject({ created: false, callId: CALL_ID });
    expect(mocks.create).toHaveBeenCalledOnce();
  });

  it("answers from the draft's row when a concurrent confirm inserted it first", async () => {
    const { draftToken } = await callEndpoint(previewCallCreate, caller, CREATE);
    // The insert lost the agent_draft_id race (null); the re-read finds the winner's row.
    mocks.create.mockResolvedValue(null);
    mocks.findByDraft.mockResolvedValueOnce(null).mockResolvedValueOnce({ id: CALL_ID, title: "Town hall", community_id: "c1" });
    const res = await confirm(draftToken);
    expect(mocks.create).toHaveBeenCalledOnce();
    expect(mocks.findByDraft).toHaveBeenCalledTimes(2);
    expect(mocks.findByDraft.mock.calls[1]).toEqual(mocks.findByDraft.mock.calls[0]);
    expect(res).toMatchObject({ action: "call_create", created: false, callId: CALL_ID, title: "Town hall", url: `http://localhost:3000/c/signius/calls/${CALL_ID}` });
  });

  it("refuses with a conflict when the insert finds nothing and the draft has no row either", async () => {
    const { draftToken } = await callEndpoint(previewCallCreate, caller, CREATE);
    mocks.create.mockResolvedValue(null);
    const err = await confirm(draftToken).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConflictError);
    expect(err).toHaveProperty("message", "The call could not be created. Preview it again.");
    expect(mocks.findByDraft).toHaveBeenCalledTimes(2);
  });

  it("refuses a draft whose request no longer matches its fingerprint, before anything is read or written", async () => {
    const { draftToken } = await callEndpoint(previewCallCreate, caller, CREATE);
    const forged = await tampered(draftToken, { title: "Something else" });
    const err = await confirm(forged).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(BadRequestError);
    expect(err).toHaveProperty("message", "This draft is not valid: preview it again");
    expect(mocks.findByDraft).not.toHaveBeenCalled();
    expect(mocks.create).not.toHaveBeenCalled();
  });
});

describe("call_finalize_preview", () => {
  it("lists who would be paid and the tasks it would create, paying nobody", async () => {
    const res = await callEndpoint(previewCallFinalize, caller, { community: "signius", call: CALL_ID });
    expect(mocks.loadForManager).toHaveBeenCalledWith(CALL_ID, "addr_w");
    expect(mocks.finalize).not.toHaveBeenCalled();
    expect(res).toMatchObject({
      action: "call_finalize",
      summary: 'Pay 2 attendees of "Town hall" into 1 attendance task',
      details: { tasks: 1, rewardEach: { ADA: "20" }, attendees: [{ name: "Person a1", wallet: "addr_1" }, { name: "Person a2", wallet: "addr_2" }] },
    });
  });

  it("says why when nobody can be paid, and refuses another community's call", async () => {
    mocks.plan.mockResolvedValue({ ready: [], standings: { ...PLAN.standings, ready: 0, rewarded: 3 }, tasks: 0 });
    await expect(callEndpoint(previewCallFinalize, caller, { community: "signius", call: CALL_ID })).rejects.toThrow("3 already rewarded");
    mocks.loadForManager.mockResolvedValue({ ...CALL, community_id: "c2" });
    await expect(callEndpoint(previewCallFinalize, caller, { community: "signius", call: CALL_ID })).rejects.toThrow("No such call");
  });

  it("pays exactly the previewed attendees, and answers a repeat as done", async () => {
    const { draftToken } = await callEndpoint(previewCallFinalize, caller, { community: "signius", call: CALL_ID });
    const res = await confirm(draftToken);
    expect(mocks.finalize).toHaveBeenCalledExactlyOnceWith(CALL, "addr_w", PLAN.ready);
    expect(res).toMatchObject({ action: "call_finalize", created: true, tasks: [41], paid: 2, remaining: 1 });

    mocks.plan.mockResolvedValue({ ready: [], standings: { ...PLAN.standings, ready: 0, rewarded: 2 }, tasks: 0 });
    expect(await confirm(draftToken)).toMatchObject({ created: false, tasks: [] });
    expect(mocks.finalize).toHaveBeenCalledOnce();
  });

  it("refuses when attendance or the reward changed since the preview", async () => {
    const { draftToken } = await callEndpoint(previewCallFinalize, caller, { community: "signius", call: CALL_ID });
    mocks.plan.mockResolvedValue({ ...PLAN, ready: [...PLAN.ready, attendee("a3", "addr_3")] });
    await expect(confirm(draftToken)).rejects.toBeInstanceOf(ConflictError);
    mocks.plan.mockResolvedValue(PLAN);
    mocks.loadForManager.mockResolvedValue({ ...CALL, amounts: { ADA: "25" } });
    await expect(confirm(draftToken)).rejects.toBeInstanceOf(ConflictError);
    expect(mocks.finalize).not.toHaveBeenCalled();
  });

  it("needs tasks:write", async () => {
    await expect(callEndpoint(previewCallFinalize, { ...caller, scopes: ["proposals:write"] }, { community: "signius", call: CALL_ID }))
      .rejects.toBeInstanceOf(ForbiddenError);
  });
});
