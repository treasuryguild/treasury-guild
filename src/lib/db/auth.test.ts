import { beforeEach, describe, expect, it, vi } from "vitest";
import { PostgrestError } from "@supabase/supabase-js";

const mocks = vi.hoisted(() => ({ from: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ serviceClient: () => ({ from: mocks.from }) }));

import { consumeNonce, loadNonce, purgeExpiredNonces, saveNonce } from "./auth";

const ADDRESS = "addr_test1me";

/** A query builder that records its chain and resolves to `result`. */
function answer(result: { data?: unknown; error: PostgrestError | null }) {
  const calls: unknown[][] = [];
  const query: Record<string, unknown> = {
    then: (ok: (v: unknown) => unknown, ko: (e: unknown) => unknown) => Promise.resolve(result).then(ok, ko),
  };
  for (const method of ["insert", "select", "delete", "eq", "lt", "maybeSingle"]) {
    query[method] = (...args: unknown[]) => {
      calls.push([method, ...args]);
      return query;
    };
  }
  mocks.from.mockReturnValue(query);
  return calls;
}

beforeEach(() => {
  vi.resetAllMocks();
});

describe("login challenges", () => {
  it("inserts a new challenge, never replacing another open one for the address", async () => {
    const calls = answer({ error: null });
    await saveNonce(ADDRESS, "n-1", "2026-10-01T00:05:00.000Z");
    expect(mocks.from).toHaveBeenCalledWith("auth_nonces");
    expect(calls).toEqual([["insert", { address: ADDRESS, nonce: "n-1", expires_at: "2026-10-01T00:05:00.000Z" }]]);
  });

  it("loads the challenge by address and text", async () => {
    const calls = answer({ data: { nonce: "n-1", expires_at: "x" }, error: null });
    expect(await loadNonce(ADDRESS, "n-1")).toEqual({ nonce: "n-1", expires_at: "x" });
    expect(calls).toContainEqual(["eq", "address", ADDRESS]);
    expect(calls).toContainEqual(["eq", "nonce", "n-1"]);
  });

  it("answers null for a challenge that was never issued", async () => {
    answer({ data: null, error: null });
    expect(await loadNonce(ADDRESS, "n-x")).toBeNull();
  });

  it("consumes a challenge once: false when another request deleted it first", async () => {
    const calls = answer({ data: [{ address: ADDRESS }], error: null });
    expect(await consumeNonce(ADDRESS, "n-1")).toBe(true);
    expect(calls).toEqual([["delete"], ["eq", "address", ADDRESS], ["eq", "nonce", "n-1"], ["select", "address"]]);
    answer({ data: [], error: null });
    expect(await consumeNonce(ADDRESS, "n-1")).toBe(false);
  });

  it("purges only the challenges that expired", async () => {
    const calls = answer({ error: null });
    await purgeExpiredNonces(new Date("2026-10-01T12:00:00.000Z"));
    expect(calls).toEqual([["delete"], ["lt", "expires_at", "2026-10-01T12:00:00.000Z"]]);
  });

  it("throws when the database fails", async () => {
    answer({ error: new PostgrestError({ message: "db down", code: "08006", details: "", hint: "" }) });
    await expect(purgeExpiredNonces(new Date())).rejects.toThrow("db down");
  });
});
