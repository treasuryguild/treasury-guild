import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthClientRow } from "@/lib/db/types";

const mocks = vi.hoisted(() => ({ find: vi.fn(), save: vi.fn(), safeHost: vi.fn(), fetch: vi.fn() }));
vi.mock("@/lib/db/oauth", () => ({ findOAuthClient: mocks.find, saveOAuthClient: mocks.save }));
vi.mock("./ssrf", async (original) => ({ ...(await original<object>()), assertSafeHost: mocks.safeHost }));

import { MAX_CLIENT_NAME, resolveClient } from "./clients";
import { MAX_REDIRECT_URIS } from "./redirects";
import { SsrfBlockedError } from "./ssrf";

const CIMD_ID = "https://client.example/oauth/metadata.json";
const DCR_ID = "gv_client_4f1c";
const NOW = new Date("2026-09-29T12:00:00Z");
const HOUR_MS = 60 * 60 * 1000;

const row = (patch: Partial<OAuthClientRow> = {}): OAuthClientRow => ({
  client_id: CIMD_ID, is_metadata_url: true, client_name: "Example Client", client_uri: null,
  redirect_uris: ["https://client.example/cb"], token_endpoint_auth_method: "none", secret_hash: null,
  created_at: "2026-09-01T00:00:00Z", last_seen_at: NOW.toISOString(), ...patch,
});
const doc = (patch: Record<string, unknown> = {}) => ({
  client_id: CIMD_ID, client_name: "Example Client", client_uri: "https://client.example",
  redirect_uris: ["https://client.example/cb", "http://127.0.0.1/callback"], ...patch,
});
const serves = (body: unknown, init: ResponseInit = {}) =>
  mocks.fetch.mockResolvedValue(new Response(typeof body === "string" ? body : JSON.stringify(body), { status: 200, ...init }));

beforeEach(() => {
  vi.resetAllMocks();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.find.mockResolvedValue(null);
  mocks.safeHost.mockResolvedValue(undefined);
  mocks.save.mockImplementation(async (client: Record<string, unknown>) => ({ ...client, created_at: NOW.toISOString(), last_seen_at: NOW.toISOString() }));
  serves(doc());
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("resolveClient: registered (DCR) client ids", () => {
  it("looks the client up in the database and fetches nothing", async () => {
    const registered = row({ client_id: DCR_ID, is_metadata_url: false, token_endpoint_auth_method: "client_secret_post", secret_hash: "h" });
    mocks.find.mockResolvedValue(registered);
    expect(await resolveClient(DCR_ID)).toBe(registered);
    expect(mocks.find).toHaveBeenCalledExactlyOnceWith(DCR_ID);
    expect(mocks.safeHost).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("answers null for an unknown client id", async () => {
    expect(await resolveClient("nobody")).toBeNull();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it.each([
    ["plain http", "http://client.example/oauth/metadata.json"],
    ["an explicit port", "https://client.example:8443/oauth/metadata.json"],
    ["no path", "https://client.example"],
    ["a bare root path", "https://client.example/"],
  ])("never fetches a URL with %s: it is only looked up", async (_what, clientId) => {
    expect(await resolveClient(clientId)).toBeNull();
    expect(mocks.find).toHaveBeenCalledExactlyOnceWith(clientId);
    expect(mocks.safeHost).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});

describe("resolveClient: Client ID Metadata Documents", () => {
  it("fetches the document behind the SSRF guard and saves the client as public", async () => {
    const client = await resolveClient(CIMD_ID);
    expect(mocks.safeHost).toHaveBeenCalledExactlyOnceWith("client.example");
    expect(mocks.fetch).toHaveBeenCalledExactlyOnceWith(CIMD_ID, expect.objectContaining({
      redirect: "error", headers: { accept: "application/json" }, signal: expect.any(AbortSignal),
    }));
    expect(mocks.safeHost.mock.invocationCallOrder[0]!).toBeLessThan(mocks.fetch.mock.invocationCallOrder[0]!);
    expect(mocks.save).toHaveBeenCalledExactlyOnceWith({
      client_id: CIMD_ID, is_metadata_url: true, client_name: "Example Client", client_uri: "https://client.example",
      redirect_uris: ["https://client.example/cb", "http://127.0.0.1/callback"],
      token_endpoint_auth_method: "none", secret_hash: null,
    });
    expect(client).toMatchObject({ client_id: CIMD_ID, client_name: "Example Client", token_endpoint_auth_method: "none" });
  });

  it("refuses a host the SSRF guard blocks, without fetching it", async () => {
    mocks.safeHost.mockRejectedValue(new SsrfBlockedError("Blocked: resolves to a private or loopback address"));
    expect(await resolveClient("https://internal.example/metadata.json")).toBeNull();
    expect(mocks.safeHost).toHaveBeenCalledWith("internal.example");
    expect(mocks.fetch).not.toHaveBeenCalled();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("drops a known client whose host now points at a private address, but keeps it through a resolver failure", async () => {
    const stale = row({ last_seen_at: new Date(NOW.getTime() - 2 * HOUR_MS).toISOString() });
    mocks.find.mockResolvedValue(stale);
    mocks.safeHost.mockRejectedValue(new SsrfBlockedError("Blocked: resolves to a private or loopback address"));
    expect(await resolveClient(CIMD_ID)).toBeNull();
    mocks.safeHost.mockRejectedValue(new Error("getaddrinfo EAI_AGAIN client.example"));
    expect(await resolveClient(CIMD_ID)).toBe(stale);
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("hands the guard the bare host of an IP-literal client id", async () => {
    mocks.safeHost.mockRejectedValue(new SsrfBlockedError("Blocked: private or loopback address"));
    expect(await resolveClient("https://169.254.169.254/latest/meta-data")).toBeNull();
    expect(mocks.safeHost).toHaveBeenCalledWith("169.254.169.254");
    expect(await resolveClient("https://[::1]/metadata.json")).toBeNull();
    expect(mocks.safeHost).toHaveBeenLastCalledWith("[::1]");
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("serves a recently seen client from the cache without fetching", async () => {
    const cached = row({ last_seen_at: new Date(NOW.getTime() - HOUR_MS + 1000).toISOString() });
    mocks.find.mockResolvedValue(cached);
    expect(await resolveClient(CIMD_ID)).toBe(cached);
    expect(mocks.safeHost).not.toHaveBeenCalled();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("re-fetches the document after an hour and saves what it says now", async () => {
    mocks.find.mockResolvedValue(row({ client_name: "Old Name", last_seen_at: new Date(NOW.getTime() - HOUR_MS).toISOString() }));
    serves(doc({ client_name: "New Name" }));
    expect(await resolveClient(CIMD_ID)).toMatchObject({ client_name: "New Name" });
    expect(mocks.fetch).toHaveBeenCalledTimes(1);
    expect(mocks.save).toHaveBeenCalledWith(expect.objectContaining({ client_name: "New Name" }));
  });

  it("keeps a known client through a transient failure, and knows no new client by one", async () => {
    const stale = row({ last_seen_at: new Date(NOW.getTime() - 2 * HOUR_MS).toISOString() });
    for (const failure of [
      () => mocks.fetch.mockRejectedValue(new TypeError("fetch failed")),
      () => serves("unavailable", { status: 503 }),
      () => serves("<html>not json</html>"),
    ]) {
      failure();
      mocks.find.mockResolvedValue(stale);
      expect(await resolveClient(CIMD_ID)).toBe(stale);
      mocks.find.mockResolvedValue(null);
      expect(await resolveClient(CIMD_ID)).toBeNull();
    }
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("refuses a document that claims another client's id", async () => {
    serves(doc({ client_id: "https://other.example/oauth/metadata.json" }));
    expect(await resolveClient(CIMD_ID)).toBeNull();
    serves(doc({ client_id: undefined }));
    expect(await resolveClient(CIMD_ID)).toBeNull();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("drops a known client whose document turned invalid, rather than serving the stale row", async () => {
    mocks.find.mockResolvedValue(row({ last_seen_at: new Date(NOW.getTime() - 2 * HOUR_MS).toISOString() }));
    serves(doc({ client_id: "https://other.example/oauth/metadata.json" }));
    expect(await resolveClient(CIMD_ID)).toBeNull();
  });

  it.each([
    ["no name", { client_name: undefined }],
    ["a blank name", { client_name: "   " }],
    ["a name that is not text", { client_name: { en: "Example" } }],
    ["no redirect URIs", { redirect_uris: undefined }],
    ["redirect URIs that are not a list", { redirect_uris: "https://client.example/cb" }],
    ["an empty redirect list", { redirect_uris: [] }],
    ["only unacceptable redirect URIs", { redirect_uris: ["javascript:alert(1)", "http://client.example/cb", "https://client.example/cb#frag", 7, "not a url"] }],
  ])("refuses a document with %s", async (_what, patch) => {
    serves(doc(patch));
    expect(await resolveClient(CIMD_ID)).toBeNull();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it.each([["null", "null"], ["a list", "[]"], ["a string", '"client"']])("refuses a document that is %s", async (_what, body) => {
    serves(body);
    expect(await resolveClient(CIMD_ID)).toBeNull();
    expect(mocks.save).not.toHaveBeenCalled();
  });

  it("keeps only acceptable redirect URIs, at most MAX_REDIRECT_URIS, and tidies the name and link", async () => {
    const many = Array.from({ length: MAX_REDIRECT_URIS + 3 }, (_, i) => `https://client.example/cb/${i}`);
    serves(doc({
      client_name: `  ${"n".repeat(MAX_CLIENT_NAME + 50)}  `, client_uri: 42,
      redirect_uris: ["javascript:alert(1)", "http://evil.example/cb", ...many],
    }));
    await resolveClient(CIMD_ID);
    const saved = mocks.save.mock.calls[0]![0];
    expect(saved.redirect_uris).toEqual(many.slice(0, MAX_REDIRECT_URIS));
    expect(saved.client_name).toBe("n".repeat(MAX_CLIENT_NAME));
    expect(saved.client_uri).toBeNull();
  });

  it("never takes a secret or an auth method from the document", async () => {
    serves(doc({ token_endpoint_auth_method: "client_secret_post", secret_hash: "x", client_secret: "s", is_metadata_url: false }));
    await resolveClient(CIMD_ID);
    expect(mocks.save.mock.calls[0]![0]).toMatchObject({ token_endpoint_auth_method: "none", secret_hash: null, is_metadata_url: true });
    expect(mocks.save.mock.calls[0]![0]).not.toHaveProperty("client_secret");
  });

  it("refuses a document past the size limit", async () => {
    serves(JSON.stringify(doc({ padding: "x".repeat(64 * 1024) })));
    expect(await resolveClient(CIMD_ID)).toBeNull();
    expect(mocks.save).not.toHaveBeenCalled();
    serves(JSON.stringify(doc({ padding: "x".repeat(32 * 1024) })));
    expect(await resolveClient(CIMD_ID)).not.toBeNull();
  });

  it("gives up on a document that does not arrive within five seconds", async () => {
    mocks.fetch.mockImplementation((_url: string, init: RequestInit) => new Promise((_resolve, reject) => {
      init.signal!.addEventListener("abort", () => reject(new DOMException("aborted", "AbortError")));
    }));
    const pending = resolveClient(CIMD_ID);
    await vi.advanceTimersByTimeAsync(4999);
    expect(mocks.fetch.mock.calls[0]![1].signal.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(await pending).toBeNull();
    expect(mocks.fetch.mock.calls[0]![1].signal.aborted).toBe(true);
  });

  it("passes on a database failure instead of treating the client as unknown", async () => {
    mocks.find.mockRejectedValue(new Error("load oauth client: timeout"));
    await expect(resolveClient(CIMD_ID)).rejects.toThrow("load oauth client: timeout");
    await expect(resolveClient(DCR_ID)).rejects.toThrow("load oauth client: timeout");
    mocks.find.mockResolvedValue(null);
    mocks.save.mockRejectedValue(new Error("save oauth client: timeout"));
    await expect(resolveClient(CIMD_ID)).rejects.toThrow("save oauth client: timeout");
  });
});
