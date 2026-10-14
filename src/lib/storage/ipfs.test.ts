import { describe, expect, it, vi } from "vitest";
import { ipfsStore } from "./ipfs";
import { copyUrl } from "./locator";

function fakePinata(cid: string) {
  const calls: { file?: File; name?: string; keyvalues?: Record<string, string> } = {};
  const builder = {
    name(name: string) { calls.name = name; return builder; },
    keyvalues(kv: Record<string, string>) { calls.keyvalues = kv; return builder; },
    then(resolve: (v: unknown) => unknown) { return Promise.resolve({ cid }).then(resolve); },
  };
  const upload = { public: { file(file: File) { calls.file = file; return builder; } } };
  return { client: { upload } as never, calls };
}

describe("ipfsStore", () => {
  it("uploads the exact bytes as a JSON file, tagged, and answers the bare CID", async () => {
    const { client, calls } = fakePinata("bafy123");
    const store = ipfsStore({ pinata: () => client, gateway: () => "gw.example" });
    const bytes = new TextEncoder().encode('{"a":1}');
    expect(await store.put(bytes, "signius-proposal-4-tally.json", { hash: "abc" })).toBe("bafy123");
    expect(calls.name).toBe("signius-proposal-4-tally.json");
    expect(calls.keyvalues).toEqual({ app: "guild-vault", hash: "abc" });
    expect(calls.file?.type).toBe("application/json");
    expect(await calls.file?.text()).toBe('{"a":1}');
  });

  it("builds the gateway URL through the shared locator helper", () => {
    const store = ipfsStore({ pinata: () => { throw new Error("unused"); }, gateway: () => "gw.example" });
    expect(store.url("bafy123")).toBe("https://gw.example/ipfs/bafy123");
    expect(copyUrl("ipfs", "bafy123", { ipfsGateway: "gw.example" })).toBe("https://gw.example/ipfs/bafy123");
  });

  it("resolves through a HEAD on the gateway; a miss or a network error is false", async () => {
    const fetchImpl = vi.fn<typeof fetch>();
    const store = ipfsStore({ pinata: () => { throw new Error("unused"); }, gateway: () => "gw.example", fetchImpl });
    fetchImpl.mockResolvedValueOnce(new Response(null, { status: 200 }));
    expect(await store.resolves("bafy123")).toBe(true);
    expect(fetchImpl).toHaveBeenCalledWith("https://gw.example/ipfs/bafy123", expect.objectContaining({ method: "HEAD" }));
    fetchImpl.mockResolvedValueOnce(new Response(null, { status: 404 }));
    expect(await store.resolves("bafy123")).toBe(false);
    fetchImpl.mockRejectedValueOnce(new Error("timeout"));
    expect(await store.resolves("bafy123")).toBe(false);
  });
});
