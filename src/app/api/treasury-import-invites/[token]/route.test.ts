import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  rate: vi.fn(),
  preview: vi.fn(),
  session: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ getSession: mocks.session }));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.rate }));
vi.mock("@/lib/db/importDrafts", () => ({ previewImportDraft: mocks.preview }));

import { GET } from "./route";

const TOKEN = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789abcdefg";
const context = { params: Promise.resolve({ token: TOKEN }) };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue(null);
  mocks.rate.mockResolvedValue(undefined);
  mocks.preview.mockResolvedValue({
    communityName: "Demo",
    treasuryName: "Imported",
    slug: "demo",
    network: 0,
    expiresAt: "2026-11-13T00:00:00.000Z",
    valid: true,
    filled: 1,
    total: 2,
  });
});

describe("GET /api/treasury-import-invites/[token]", () => {
  it("returns a public preview without key hashes", async () => {
    const res = await GET(new Request(`http://localhost/api/treasury-import-invites/${TOKEN}`), context);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      communityName: "Demo",
      treasuryName: "Imported",
      slug: "demo",
      network: 0,
      expiresAt: "2026-11-13T00:00:00.000Z",
      valid: true,
      filled: 1,
      total: 2,
    });
    expect(mocks.rate).toHaveBeenCalledWith("importDraftPreview", expect.any(String));
    expect(mocks.preview).toHaveBeenCalledWith(TOKEN);
  });

  it("404s when the invite is unknown", async () => {
    mocks.preview.mockResolvedValue(null);
    const res = await GET(new Request(`http://localhost/api/treasury-import-invites/${TOKEN}`), context);
    expect(res.status).toBe(404);
  });
});
