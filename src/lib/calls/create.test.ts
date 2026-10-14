// The checks and the hand-made create run through POST /api/calls; this
// covers the agent API's draft-keyed create, which only call_create reaches.
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ForbiddenError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  community: vi.fn(), manager: vi.fn(), active: vi.fn(), captureRef: vi.fn(),
  insert: vi.fn(), insertDraft: vi.fn(), replay: vi.fn(),
}));
vi.mock("@/lib/db/workgroups", () => ({ requireWorkgroupCommunity: mocks.community, requireActiveWorkgroup: mocks.active }));
vi.mock("./access", () => ({ requireWorkgroupManager: mocks.manager }));
vi.mock("./capture", () => ({ assertCaptureRef: mocks.captureRef }));
vi.mock("./zoomCapture", () => ({ replayPendingZoomSessions: mocks.replay }));
vi.mock("@/lib/db/calls", () => ({ insertCall: mocks.insert, insertDraftCall: mocks.insertDraft }));

import { createCall, type CreateCallInput } from "./create";

const DRAFT = "d0000000000040008000000000000001";
const input = (overrides: Partial<CreateCallInput> = {}): CreateCallInput => ({
  workgroupId: "wg-1", provider: "zoom", title: "Town hall", externalRef: "123456789",
  startsAt: "2026-10-01T18:00:00Z", endsAt: "2026-10-01T19:00:00Z", amounts: { ADA: "5" },
  minSnapshots: 1, minMinutes: 30,
  ...overrides,
} as CreateCallInput);

beforeEach(() => {
  vi.resetAllMocks();
  mocks.community.mockResolvedValue("comm-1");
  mocks.replay.mockResolvedValue(0);
  mocks.insertDraft.mockImplementation(async (call: object) => ({ id: "call-1", ...call }));
});

describe("createCall with an agent API draft", () => {
  it("inserts the call keyed by the draft, never through the plain insert, and replays parked Zoom joins", async () => {
    const call = await createCall(input(), "lead", { agentDraftId: DRAFT });
    expect(call).toMatchObject({ id: "call-1", title: "Town hall" });
    expect(mocks.insertDraft).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ workgroup_id: "wg-1", provider: "zoom", external_ref: "123456789", created_by: "lead" }),
      "comm-1",
      DRAFT,
    );
    expect(mocks.insert).not.toHaveBeenCalled();
    expect(mocks.replay).toHaveBeenCalledExactlyOnceWith(call);
  });

  it("answers null, replaying nothing, when the draft already made its call", async () => {
    mocks.insertDraft.mockResolvedValue(null);
    expect(await createCall(input(), "lead", { agentDraftId: DRAFT })).toBeNull();
    expect(mocks.replay).not.toHaveBeenCalled();
  });

  it("refuses a workgroup of another community than the draft's before writing anything", async () => {
    await expect(createCall(input(), "lead", { agentDraftId: DRAFT, communityId: "comm-2" }))
      .rejects.toThrow("This draft belongs to another community");
    expect(mocks.insertDraft).not.toHaveBeenCalled();
    expect(await createCall(input(), "lead", { agentDraftId: DRAFT, communityId: "comm-1" })).toMatchObject({ id: "call-1" });
  });

  it("runs every check before the insert, so a refused confirm writes nothing", async () => {
    mocks.manager.mockRejectedValue(new ForbiddenError("Only admins and workgroup leads can manage calls"));
    await expect(createCall(input(), "member", { agentDraftId: DRAFT })).rejects.toThrow(ForbiddenError);
    expect(mocks.insertDraft).not.toHaveBeenCalled();
  });
});
