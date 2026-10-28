import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  preview: vi.fn(),
  rate: vi.fn(),
  session: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session }));
vi.mock("@/lib/db/invites", () => ({ previewInvite: mocks.preview }));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.rate }));

import { GET } from "./route";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg";

const get = (token: string) =>
  GET(new Request(`http://localhost/api/invites/${token}`), {
    params: Promise.resolve({ token }),
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue(null);
  mocks.rate.mockResolvedValue(undefined);
  mocks.preview.mockResolvedValue({
    name: "Demo",
    slug: "demo",
    network: 0,
    valid: true,
  });
});

describe("GET /api/invites/[token]", () => {
  it("returns the community preview without a session", async () => {
    const res = await get(TOKEN);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      name: "Demo",
      slug: "demo",
      network: 0,
      valid: true,
    });
    expect(mocks.preview).toHaveBeenCalledWith(TOKEN);
    expect(mocks.rate).toHaveBeenCalledWith("invitePreview", expect.any(String));
  });

  it("answers 404 when the token is unknown", async () => {
    mocks.preview.mockResolvedValue(null);
    expect((await get(TOKEN)).status).toBe(404);
  });

  it("refuses a malformed token", async () => {
    expect((await get("short")).status).toBe(400);
    expect(mocks.preview).not.toHaveBeenCalled();
  });
});
