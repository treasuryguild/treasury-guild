import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  preview: vi.fn(),
  rate: vi.fn(),
  session: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session }));
vi.mock("@/lib/db/signerDrafts", () => ({ previewSignerDraft: mocks.preview }));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.rate }));

import { GET } from "./route";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg";
const get = (token: string) =>
  GET(new Request(`http://localhost/api/treasury-signer-invites/${token}`), {
    params: Promise.resolve({ token }),
  });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue(null);
  mocks.rate.mockResolvedValue(undefined);
  mocks.preview.mockResolvedValue({
    communityName: "Demo",
    treasuryName: "Main",
    slug: "demo",
    network: 0,
    expiresAt: "2026-11-05T00:00:00.000Z",
    valid: true,
    filled: 1,
    total: 2,
  });
});

describe("GET /api/treasury-signer-invites/[token]", () => {
  it("returns names and a count, not signer addresses", async () => {
    const res = await get(TOKEN);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      communityName: "Demo",
      treasuryName: "Main",
      slug: "demo",
      network: 0,
      expiresAt: "2026-11-05T00:00:00.000Z",
      valid: true,
      filled: 1,
      total: 2,
    });
    expect(mocks.rate).toHaveBeenCalledWith("signerDraftPreview", expect.any(String));
    expect(JSON.stringify(await get(TOKEN).then((r) => r.json()))).not.toContain("addr");
  });

  it("answers 404 when the token is unknown", async () => {
    mocks.preview.mockResolvedValue(null);
    expect((await get(TOKEN)).status).toBe(404);
  });
});
