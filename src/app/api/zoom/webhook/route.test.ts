import { createHmac } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  seen: new Set<string>(),
  deauthorize: vi.fn(),
  participant: vi.fn(),
  ended: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: async () => null }));
vi.mock("@/lib/db/callCapture", () => ({
  deleteIntegrationsByAccount: mocks.deauthorize,
  // What the table's primary key does: a signature is accepted once.
  markZoomDeliverySeen: async (signature: string) => {
    if (mocks.seen.has(signature)) return false;
    mocks.seen.add(signature);
    return true;
  },
}));
vi.mock("@/lib/calls/zoomCapture", () => ({
  recordZoomParticipantEvent: mocks.participant,
  recordZoomMeetingEnded: mocks.ended,
}));
import { POST } from "./route";

const SECRET = "zoom-secret";
const context = { params: Promise.resolve({}) };

function signed(event: object, ts = Math.floor(Date.now() / 1000)): Request {
  const body = JSON.stringify(event);
  return new Request("http://localhost/api/zoom/webhook", {
    method: "POST",
    body,
    headers: {
      "content-type": "application/json",
      "x-zm-request-timestamp": String(ts),
      "x-zm-signature": `v0=${createHmac("sha256", SECRET).update(`v0:${ts}:${body}`).digest("hex")}`,
    },
  });
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.seen.clear();
  process.env.ZOOM_WEBHOOK_SECRET_TOKEN = SECRET;
});

describe("POST /api/zoom/webhook", () => {
  it("refuses an unsigned request", async () => {
    const res = await POST(new Request("http://localhost/api/zoom/webhook", { method: "POST", body: "{}" }), context);
    expect(res.status).toBe(401);
  });

  it("handles a signed delivery once and ignores the same request sent again", async () => {
    const event = { event: "app_deauthorized", payload: { account_id: "acct" } };
    const ts = Math.floor(Date.now() / 1000);
    expect(await (await POST(signed(event, ts), context)).json()).toEqual({ ok: true });
    // A replay inside the signature window must not drop a connection re-made since.
    expect(await (await POST(signed(event, ts), context)).json()).toEqual({ ok: true, outcome: "duplicate" });
    expect(mocks.deauthorize).toHaveBeenCalledTimes(1);
  });

  it("still takes a redelivery: Zoom's retry has a new timestamp, so a new signature", async () => {
    const event = { event: "app_deauthorized", payload: { account_id: "acct" } };
    const ts = Math.floor(Date.now() / 1000);
    await POST(signed(event, ts - 30), context);
    await POST(signed(event, ts), context);
    expect(mocks.deauthorize).toHaveBeenCalledTimes(2);
  });
});
