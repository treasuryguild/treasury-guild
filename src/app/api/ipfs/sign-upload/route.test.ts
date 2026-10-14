import { beforeEach, describe, expect, it, vi } from "vitest";
import { MAX_IMAGE_BYTES } from "@/lib/api/schemas";
import type * as EnvModule from "@/lib/env.server";
import { ForbiddenError, NotFoundError, TooManyRequestsError, UnauthorizedError } from "@/lib/errors";

const mocks = vi.hoisted(() => ({
  session: vi.fn(), member: vi.fn(), limit: vi.fn(), slug: vi.fn(), sdk: vi.fn(), sign: vi.fn(), jwt: vi.fn(), gateway: vi.fn(),
}));
vi.mock("@/lib/auth/session", () => ({ requireSession: mocks.session }));
vi.mock("@/lib/authz", () => ({ requireMember: mocks.member }));
vi.mock("@/lib/db/rateLimit", () => ({ enforceRateLimit: mocks.limit }));
vi.mock("@/lib/db/communities", () => ({ communitySlug: mocks.slug }));
vi.mock("@/lib/env.server", async (importOriginal) => ({
  ...(await importOriginal<typeof EnvModule>()),
  pinataJwt: mocks.jwt, pinataGateway: mocks.gateway,
}));
vi.mock("pinata", () => ({
  PinataSDK: class {
    upload = { public: { createSignedURL: mocks.sign } };
    constructor(config: unknown) { mocks.sdk(config); }
  },
}));
import { POST } from "./route";

const WALLET = "addr_test1member";
const COMMUNITY = "10000000-0000-4000-8000-000000000001";
const JWT = "pinata-jwt-secret";
const SIGNED = "https://uploads.pinata.cloud/v3/files/signed-1";
const MAX = MAX_IMAGE_BYTES;
const context = { params: Promise.resolve({}) };
const post = (body: object, headers: Record<string, string> = {}) => POST(new Request("http://localhost/api/ipfs/sign-upload", {
  method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json", ...headers },
}), context);
const body = (overrides: object = {}) => ({ communityId: COMMUNITY, name: "logo.png", mimeType: "image/png", size: 2048, ...overrides });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.session.mockResolvedValue({ wallet: WALLET });
  mocks.member.mockResolvedValue("member");
  mocks.limit.mockResolvedValue(undefined);
  mocks.slug.mockResolvedValue("signius");
  mocks.jwt.mockReturnValue(JWT);
  mocks.gateway.mockReturnValue("guild.mypinata.cloud");
  mocks.sign.mockResolvedValue(SIGNED);
});

function nothingSigned() {
  expect(mocks.sdk).not.toHaveBeenCalled();
  expect(mocks.sign).not.toHaveBeenCalled();
}

describe("POST /api/ipfs/sign-upload", () => {
  it("signs a two-minute upload URL for a member's image and keeps the JWT on the server", async () => {
    const res = await post(body());
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({ url: SIGNED, gateway: "guild.mypinata.cloud" });
    expect(text).not.toContain(JWT);
    expect(mocks.member).toHaveBeenCalledWith(COMMUNITY, WALLET);
    expect(mocks.limit).toHaveBeenCalledWith("ipfsUpload", WALLET);
    expect(mocks.slug).toHaveBeenCalledWith(COMMUNITY);
    expect(mocks.sdk).toHaveBeenCalledWith({ pinataJwt: JWT, pinataGateway: "guild.mypinata.cloud" });
    expect(mocks.sign).toHaveBeenCalledExactlyOnceWith({
      expires: 120, name: "signius/logo.png", mimeTypes: ["image/png"], maxFileSize: MAX,
      keyvalues: { app: "guild-vault", community: "signius", uploader: WALLET },
    });
  });

  it("caps the upload at the image limit whatever size was declared, and cleans the file name", async () => {
    await post(body({ name: "my logo (final)!.png", size: 1 }));
    expect(mocks.sign).toHaveBeenLastCalledWith(expect.objectContaining({ name: "signius/my_logo_final_.png", maxFileSize: MAX }));
    await post(body({ name: "../../etc/passwd" }));
    expect(mocks.sign).toHaveBeenLastCalledWith(expect.objectContaining({ name: "signius/.._.._etc_passwd" }));
    await post(body({ name: "a".repeat(200) }));
    expect(mocks.sign).toHaveBeenLastCalledWith(expect.objectContaining({ name: `signius/${"a".repeat(100)}` }));
    await post(body({ name: undefined, mimeType: "image/webp" }));
    expect(mocks.sign).toHaveBeenLastCalledWith(expect.objectContaining({ name: "signius/image", mimeTypes: ["image/webp"] }));
  });

  it("refuses an SVG, which can carry scripts, before checking membership", async () => {
    for (const mimeType of ["image/svg+xml", "IMAGE/SVG+XML", "image/svg"]) {
      const response = await post(body({ name: "logo.svg", mimeType }));
      expect(response.status).toBe(400);
    }
    expect((await (await post(body({ mimeType: "image/svg+xml" }))).json()).error)
      .toContain("SVG images cannot be uploaded: use PNG, JPEG, GIF or WebP");
    expect(mocks.member).not.toHaveBeenCalled();
    nothingSigned();
  });

  it("requires a session and the same origin", async () => {
    mocks.session.mockRejectedValueOnce(new UnauthorizedError());
    expect((await post(body())).status).toBe(401);
    expect((await post(body(), { origin: "https://evil.test" })).status).toBe(403);
    expect(mocks.member).not.toHaveBeenCalled();
    nothingSigned();
  });

  it("refuses anything but an image of at most 10 MB before checking membership", async () => {
    const invalid = [
      body({ mimeType: "text/html" }), body({ mimeType: "application/pdf" }), body({ mimeType: undefined }),
      body({ size: 0 }), body({ size: MAX + 1 }), body({ size: 1.5 }), body({ size: undefined }),
      body({ communityId: "nope" }), body({ name: "a".repeat(201) }), {},
    ];
    for (const value of invalid) expect((await post(value)).status).toBe(400);
    expect(mocks.member).not.toHaveBeenCalled();
    expect(mocks.limit).not.toHaveBeenCalled();
    nothingSigned();
  });

  it("refuses a wallet outside the community without charging its rate limit", async () => {
    mocks.member.mockRejectedValue(new ForbiddenError("Not a community member"));
    expect((await post(body())).status).toBe(403);
    expect(mocks.limit).not.toHaveBeenCalled();
    nothingSigned();
  });

  it("stops at the per-wallet upload limit before asking Pinata", async () => {
    mocks.limit.mockRejectedValue(new TooManyRequestsError());
    expect((await post(body())).status).toBe(429);
    expect(mocks.slug).not.toHaveBeenCalled();
    nothingSigned();
  });

  it("answers 404 for a community that is gone", async () => {
    mocks.slug.mockRejectedValue(new NotFoundError("Community not found"));
    expect((await post(body())).status).toBe(404);
    nothingSigned();
  });
});
