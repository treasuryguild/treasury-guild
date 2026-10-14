import { beforeEach, describe, expect, it, vi } from "vitest";
import { PostgrestError } from "@supabase/supabase-js";
import { PgCode } from "@/lib/constants";
import { ConflictError, NotFoundError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ serviceClient: () => ({ from: mocks.from, rpc: mocks.rpc }) }));

import { deleteCallWithoutTasks, finalizeCall, findCallByDraft, insertDraftCall, listCommunityCalls, setCallAmounts } from "./calls";

const CALL = "c0000000-0000-4000-8000-000000000001";
const refusal = (code: string, message: string) => ({ data: null, error: new PostgrestError({ message, code, details: "", hint: "" }) });

beforeEach(() => {
  vi.resetAllMocks();
});

describe("finalizeCall", () => {
  const ARGS = { callId: CALL, actor: "addr_test1lead", attendeeIds: ["a-1", "a-2"], chunk: 20, bountyLovelace: "5000000", amounts: { ADA: "5" } };

  it("finalizes at the reward the bounty was derived from (finalize_call_at_reward)", async () => {
    mocks.rpc.mockResolvedValue({ data: { taskIds: ["t-1"], paid: 2, remaining: 0 }, error: null });
    expect(await finalizeCall(ARGS)).toEqual({ taskIds: ["t-1"], paid: 2, remaining: 0 });
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("finalize_call_at_reward", {
      p_call_id: CALL, p_actor: "addr_test1lead", p_attendee_ids: ["a-1", "a-2"], p_chunk: 20, p_bounty_lovelace: "5000000", p_amounts: { ADA: "5" },
    });
  });

  it("refuses with 409 when the reward changed meanwhile", async () => {
    mocks.rpc.mockResolvedValue(refusal(PgCode.CheckViolation, "The reward changed while finalizing: reload the call and try again"));
    await expect(finalizeCall(ARGS)).rejects.toThrow(new ConflictError("The reward changed while finalizing: reload the call and try again"));
  });

  it("maps a unique violation (a wallet already on a task) to 409 too", async () => {
    mocks.rpc.mockResolvedValue(refusal(PgCode.UniqueViolation, "duplicate key"));
    await expect(finalizeCall(ARGS)).rejects.toThrow(ConflictError);
  });
});

describe("setCallAmounts", () => {
  it("sets the reward under the call's lock (set_call_amounts), then returns the row", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    const eq = vi.fn(() => ({ single: async () => ({ data: { id: CALL, amounts: { ADA: "7" } }, error: null }) }));
    mocks.from.mockReturnValue({ select: () => ({ eq }) });
    expect(await setCallAmounts(CALL, { ADA: "7" })).toMatchObject({ id: CALL, amounts: { ADA: "7" } });
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("set_call_amounts", { p_call_id: CALL, p_amounts: { ADA: "7" } });
    expect(mocks.from).toHaveBeenCalledWith("calls");
    expect(eq).toHaveBeenCalledWith("id", CALL);
  });

  it("refuses with 409 once attendance tasks exist, without reading the row", async () => {
    mocks.rpc.mockResolvedValue(refusal(PgCode.CheckViolation, "The reward is locked once attendance tasks exist"));
    await expect(setCallAmounts(CALL, { ADA: "7" })).rejects.toThrow(new ConflictError("The reward is locked once attendance tasks exist"));
    expect(mocks.from).not.toHaveBeenCalled();
  });
});

describe("deleteCallWithoutTasks", () => {
  it("deletes through delete_call_without_tasks", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: null });
    await deleteCallWithoutTasks(CALL);
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("delete_call_without_tasks", { p_call_id: CALL });
  });

  it("refuses with 409 for a call with tasks and 404 for a missing one", async () => {
    mocks.rpc.mockResolvedValue(refusal(PgCode.CheckViolation, "This call already has attendance tasks and stays as their record"));
    await expect(deleteCallWithoutTasks(CALL)).rejects.toThrow(ConflictError);
    mocks.rpc.mockResolvedValue(refusal(PgCode.NoDataFound, "Call not found"));
    await expect(deleteCallWithoutTasks(CALL)).rejects.toThrow(new NotFoundError("Call not found"));
  });
});

describe("insertDraftCall", () => {
  const DRAFT = "d0000000-0000-4000-8000-000000000001";
  const NEW = {
    workgroup_id: "wg-1", provider: "zoom" as const, title: "Weekly", external_ref: "123", starts_at: "2026-10-01T10:00:00Z",
    ends_at: "2026-10-01T11:00:00Z", amounts: { ADA: "5" }, min_snapshots: 1, min_minutes: 30, created_by: "addr_test1lead",
  };
  let insert: ReturnType<typeof vi.fn>;
  const answer = (res: unknown) => {
    insert = vi.fn(() => ({ select: () => ({ single: async () => res }) }));
    mocks.from.mockReturnValue({ insert });
  };

  it("inserts the call in the community, keyed by the draft", async () => {
    answer({ data: { id: CALL }, error: null });
    expect(await insertDraftCall(NEW, "comm-1", DRAFT)).toEqual({ id: CALL });
    expect(mocks.from).toHaveBeenCalledWith("calls");
    expect(insert).toHaveBeenCalledExactlyOnceWith({ ...NEW, community_id: "comm-1", agent_draft_id: DRAFT });
  });

  it("answers null when the draft already made a call (unique agent_draft_id)", async () => {
    answer(refusal(PgCode.UniqueViolation, "duplicate key value violates unique constraint \"calls_agent_draft_uq\""));
    expect(await insertDraftCall(NEW, "comm-1", DRAFT)).toBeNull();
  });

  it("throws any other failure", async () => {
    answer(refusal("42501", "permission denied"));
    await expect(insertDraftCall(NEW, "comm-1", DRAFT)).rejects.toThrow();
  });

  it("finds the call a draft made, null when it made none", async () => {
    let found: unknown = { id: CALL };
    const eq = vi.fn(() => ({ maybeSingle: async () => ({ data: found, error: null }) }));
    mocks.from.mockReturnValue({ select: () => ({ eq }) });
    expect(await findCallByDraft(DRAFT)).toEqual({ id: CALL });
    expect(eq).toHaveBeenCalledWith("agent_draft_id", DRAFT);
    found = null;
    expect(await findCallByDraft(DRAFT)).toBeNull();
  });
});

describe("listCommunityCalls", () => {
  /** A query builder that records its chain and resolves to `result`. */
  function recordQuery(result: { data?: unknown; error: PostgrestError | null }) {
    const calls: unknown[][] = [];
    const query: Record<string, unknown> = {
      then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(result).then(ok, ko),
    };
    for (const method of ["select", "eq", "order", "limit"]) {
      query[method] = (...args: unknown[]) => {
        calls.push([method, ...args]);
        return query;
      };
    }
    mocks.from.mockReturnValue(query);
    return calls;
  }
  const eqs = (calls: unknown[][]) => calls.filter((c) => c[0] === "eq");

  it("lists the community's calls, newest first, filtered by the community only", async () => {
    const calls = recordQuery({ data: [{ id: CALL }], error: null });
    expect(await listCommunityCalls("comm-1", { limit: 20 })).toEqual([{ id: CALL }]);
    expect(mocks.from).toHaveBeenCalledWith("calls");
    expect(eqs(calls)).toEqual([["eq", "community_id", "comm-1"]]);
    expect(calls).toContainEqual(["order", "starts_at", { ascending: false }]);
    expect(calls).toContainEqual(["limit", 20]);
  });

  it("reads attendees without the platform account ids", async () => {
    const calls = recordQuery({ data: [], error: null });
    await listCommunityCalls("comm-1", { limit: 5 });
    const select = String(calls.find((c) => c[0] === "select")?.[1]);
    expect(select).toContain("call_attendees(");
    expect(select).not.toContain("external_id");
  });

  it("narrows to a state and to one call when asked", async () => {
    const calls = recordQuery({ data: [], error: null });
    await listCommunityCalls("comm-1", { state: "open", callId: CALL, limit: 1 });
    expect(eqs(calls)).toEqual([["eq", "community_id", "comm-1"], ["eq", "state", "open"], ["eq", "id", CALL]]);
  });

  it("throws when the read fails", async () => {
    recordQuery(refusal("42501", "permission denied"));
    await expect(listCommunityCalls("comm-1", { limit: 5 })).rejects.toThrow("list community calls: permission denied");
  });
});
