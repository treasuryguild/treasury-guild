import { beforeEach, describe, expect, it, vi } from "vitest";
import { PostgrestError } from "@supabase/supabase-js";
import { PgCode } from "@/lib/constants";

const mocks = vi.hoisted(() => ({ insert: vi.fn() }));
vi.mock("@/lib/supabase/service", () => ({ serviceClient: () => ({ from: () => ({ insert: mocks.insert }) }) }));

import { recordWebhookDelivery } from "./github";

const DELIVERY = { deliveryId: "d-1", event: "issues", action: "edited", payload: { action: "edited" } };
const failure = (code: string, message: string) => ({ error: new PostgrestError({ message, code, details: "", hint: "" }) });

beforeEach(() => {
  vi.resetAllMocks();
});

describe("recordWebhookDelivery", () => {
  it("records a new delivery", async () => {
    mocks.insert.mockResolvedValue({ error: null });
    expect(await recordWebhookDelivery(DELIVERY)).toBe(true);
    expect(mocks.insert).toHaveBeenCalledWith({ delivery_id: "d-1", event: "issues", action: "edited", payload: { action: "edited" } });
  });

  it("reads only a unique violation as a redelivery", async () => {
    mocks.insert.mockResolvedValue(failure(PgCode.UniqueViolation, "duplicate key value violates unique constraint"));
    expect(await recordWebhookDelivery(DELIVERY)).toBe(false);
  });

  it("throws any other failure, so the webhook answers 500 and GitHub retries", async () => {
    mocks.insert.mockResolvedValue(failure("08006", "connection failure"));
    await expect(recordWebhookDelivery(DELIVERY)).rejects.toThrow("connection failure");
  });
});
