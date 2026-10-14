import { beforeEach, describe, expect, it, vi } from "vitest";
import { PostgrestError } from "@supabase/supabase-js";
import { IntegrationProvider } from "@/lib/constants";

const mocks = vi.hoisted(() => ({ from: vi.fn(), rpc: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ serviceClient: () => ({ from: mocks.from, rpc: mocks.rpc }) }));

import { loadConnectedDiscordGuilds, saveIntegration } from "./callCapture";

const INTEGRATION = {
  community_id: "10000000-0000-4000-8000-000000000001",
  provider: IntegrationProvider.Zoom,
  external_account_id: "zoom-acc",
  label: "Signius Host",
  created_by: "addr_test1admin",
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe("saveIntegration", () => {
  it("saves the connection and its tokens in one save_call_integration step", async () => {
    mocks.rpc.mockResolvedValue({ data: "i-1", error: null });
    const secrets = { access_token: "a", refresh_token: "r", expires_at: "2026-10-01T13:00:00.000Z" };
    expect(await saveIntegration(INTEGRATION, secrets)).toEqual({ id: "i-1" });
    expect(mocks.rpc).toHaveBeenCalledExactlyOnceWith("save_call_integration", {
      p_community_id: INTEGRATION.community_id,
      p_provider: "zoom",
      p_external_account_id: "zoom-acc",
      p_label: "Signius Host",
      p_created_by: "addr_test1admin",
      p_access_token: "a",
      p_refresh_token: "r",
      p_expires_at: "2026-10-01T13:00:00.000Z",
    });
  });

  it("sends null tokens for a connection that keeps none (a Discord server)", async () => {
    mocks.rpc.mockResolvedValue({ data: "i-2", error: null });
    await saveIntegration({ ...INTEGRATION, provider: IntegrationProvider.Discord, external_account_id: "guild-1" }, null);
    expect(mocks.rpc).toHaveBeenCalledWith("save_call_integration", expect.objectContaining({
      p_provider: "discord", p_access_token: null, p_refresh_token: null, p_expires_at: null,
    }));
  });

  it("throws when the save fails, so neither the row nor its tokens are kept", async () => {
    mocks.rpc.mockResolvedValue({ data: null, error: new PostgrestError({ message: "db down", code: "08006", details: "", hint: "" }) });
    await expect(saveIntegration(INTEGRATION, null)).rejects.toThrow("db down");
  });
});

describe("loadConnectedDiscordGuilds", () => {
  it("returns the server ids of every Discord connection", async () => {
    const eq = vi.fn(async () => ({ data: [{ external_account_id: "g-1" }, { external_account_id: "g-2" }], error: null }));
    const select = vi.fn(() => ({ eq }));
    mocks.from.mockReturnValue({ select });
    expect(await loadConnectedDiscordGuilds()).toEqual(new Set(["g-1", "g-2"]));
    expect(mocks.from).toHaveBeenCalledWith("call_integrations");
    expect(select).toHaveBeenCalledWith("external_account_id");
    expect(eq).toHaveBeenCalledWith("provider", "discord");
  });

  it("throws rather than answering empty when the read fails (an empty set would orphan every server)", async () => {
    mocks.from.mockReturnValue({
      select: () => ({ eq: async () => ({ data: null, error: new PostgrestError({ message: "db down", code: "08006", details: "", hint: "" }) }) }),
    });
    await expect(loadConnectedDiscordGuilds()).rejects.toThrow("db down");
  });
});
