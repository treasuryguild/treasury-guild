import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  fetchMeta: vi.fn(),
  pinnedFetch: vi.fn(),
}));
vi.mock("./koios", () => ({ fetchPoolMetadata: mocks.fetchMeta }));
vi.mock("@/lib/oauthServer/ssrf", () => ({
  fetchWithPinnedDns: mocks.pinnedFetch,
  SsrfBlockedError: class SsrfBlockedError extends Error {},
}));

import {
  asHttpsIconUrl,
  extractExtendedMetaUrl,
  extractIconUrlFromPoolMeta,
  iconUrlFromPoolMetadataRow,
  POOL_ICON_URL_MAX_LEN,
  resolvePoolIconUrl,
} from "./poolIcon";

const ICON = "https://cdn.example/icon64.png";
const LOGO = "https://cdn.example/logo.png";
const EXTENDED = "https://cdn.example/extended.json";

function jsonResponse(body: unknown, ok = true): Response {
  return new Response(JSON.stringify(body), {
    status: ok ? 200 : 500,
    headers: { "content-type": "application/json" },
  });
}

describe("asHttpsIconUrl", () => {
  it("accepts https URLs within the length cap", () => {
    expect(asHttpsIconUrl(ICON)).toBe(ICON);
    expect(asHttpsIconUrl(`  ${ICON}  `)).toBe(ICON);
  });

  it("refuses http, non-URLs, and overlong strings", () => {
    expect(asHttpsIconUrl("http://cdn.example/icon.png")).toBeNull();
    expect(asHttpsIconUrl("not-a-url")).toBeNull();
    expect(asHttpsIconUrl("")).toBeNull();
    expect(asHttpsIconUrl(`https://x.example/${"a".repeat(POOL_ICON_URL_MAX_LEN)}`)).toBeNull();
  });
});

describe("extractIconUrlFromPoolMeta", () => {
  it("prefers the 64x64 icon over the logo", () => {
    expect(
      extractIconUrlFromPoolMeta({
        info: { url_png_icon_64x64: ICON, url_png_logo: LOGO },
      }),
    ).toBe(ICON);
    expect(extractIconUrlFromPoolMeta({ info: { url_png_logo: LOGO } })).toBe(LOGO);
  });

  it("returns null without usable info icons", () => {
    expect(extractIconUrlFromPoolMeta(null)).toBeNull();
    expect(extractIconUrlFromPoolMeta({ ticker: "SIG" })).toBeNull();
    expect(extractIconUrlFromPoolMeta({ info: { url_png_logo: "http://insecure" } })).toBeNull();
  });
});

describe("extractExtendedMetaUrl", () => {
  it("reads a https extended URL", () => {
    expect(extractExtendedMetaUrl({ extended: EXTENDED })).toBe(EXTENDED);
    expect(extractExtendedMetaUrl({ extended: "ftp://no" })).toBeNull();
  });
});

describe("iconUrlFromPoolMetadataRow", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("uses an icon already present on meta_json", async () => {
    await expect(
      iconUrlFromPoolMetadataRow({
        meta_json: { info: { url_png_icon_64x64: ICON } },
      }),
    ).resolves.toBe(ICON);
    expect(mocks.pinnedFetch).not.toHaveBeenCalled();
  });

  it("fetches meta_url when meta_json is empty", async () => {
    mocks.pinnedFetch.mockResolvedValue(
      jsonResponse({ info: { url_png_logo: LOGO } }),
    );
    await expect(
      iconUrlFromPoolMetadataRow({ meta_url: "https://cdn.example/meta.json", meta_json: null }),
    ).resolves.toBe(LOGO);
  });

  it("follows a one-hop extended URL", async () => {
    mocks.pinnedFetch.mockResolvedValue(
      jsonResponse({ info: { url_png_icon_64x64: ICON } }),
    );
    await expect(
      iconUrlFromPoolMetadataRow({
        meta_json: {
          name: "SIG",
          extended: EXTENDED,
        },
      }),
    ).resolves.toBe(ICON);
    expect(mocks.pinnedFetch).toHaveBeenCalledWith(
      EXTENDED,
      expect.objectContaining({ redirect: "error" }),
    );
  });

  it("returns null when extended fetch fails", async () => {
    mocks.pinnedFetch.mockRejectedValue(new Error("blocked"));
    await expect(
      iconUrlFromPoolMetadataRow({ meta_json: { extended: EXTENDED } }),
    ).resolves.toBeNull();
  });
});

describe("resolvePoolIconUrl", () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it("returns null when Koios has no metadata row", async () => {
    mocks.fetchMeta.mockResolvedValue(null);
    await expect(resolvePoolIconUrl(0, "pool1abc")).resolves.toBeNull();
  });

  it("swallows Koios failures", async () => {
    mocks.fetchMeta.mockRejectedValue(new Error("upstream"));
    await expect(resolvePoolIconUrl(0, "pool1abc")).resolves.toBeNull();
  });

  it("returns the resolved icon from Koios metadata", async () => {
    mocks.fetchMeta.mockResolvedValue({
      meta_json: { info: { url_png_icon_64x64: ICON } },
    });
    await expect(resolvePoolIconUrl(0, "pool1abc")).resolves.toBe(ICON);
  });
});
