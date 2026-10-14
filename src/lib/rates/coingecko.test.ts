import { beforeEach, describe, expect, it, vi } from "vitest";
import { clearRateCache, fetchExchangeRate } from "./coingecko";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

beforeEach(() => {
  clearRateCache();
  vi.spyOn(console, "warn").mockImplementation(() => {});
});

describe("fetchExchangeRate", () => {
  it("reads price and symbol from /coins/markets and caches per coin+currency", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(json([{ symbol: "ada", current_price: 0.4212 }]));
    const rate = await fetchExchangeRate("cardano", "USD", fetchImpl, 1_000);
    expect(rate).toEqual({ price: 0.4212, currency: "usd", symbol: "ADA" });
    expect(String(fetchImpl.mock.calls[0]?.[0])).toBe(
      "https://api.coingecko.com/api/v3/coins/markets?vs_currency=USD&ids=cardano&precision=full",
    );

    expect(await fetchExchangeRate("cardano", "USD", fetchImpl, 2_000)).toEqual(rate);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // a different currency is its own lookup; the cache expires after 5 minutes
    await fetchExchangeRate("cardano", "eur", fetchImpl, 2_000);
    await fetchExchangeRate("cardano", "USD", fetchImpl, 1_000 + 6 * 60 * 1000);
    expect(fetchImpl).toHaveBeenCalledTimes(3);
  });

  it("returns null for unknown coins, bad payloads, HTTP errors and network failures", async () => {
    expect(await fetchExchangeRate("nope", "usd", vi.fn().mockResolvedValue(json([])))).toBeNull();
    expect(await fetchExchangeRate("a", "usd", vi.fn().mockResolvedValue(json([{ symbol: "a" }])))).toBeNull();
    expect(await fetchExchangeRate("b", "usd", vi.fn().mockResolvedValue(json({ error: "x" }, 429)))).toBeNull();
    expect(await fetchExchangeRate("c", "usd", vi.fn().mockRejectedValue(new Error("offline")))).toBeNull();
  });

  it("falls back to the coin id as the symbol", async () => {
    const rate = await fetchExchangeRate("mytoken", "usd", vi.fn().mockResolvedValue(json([{ current_price: 2 }])));
    expect(rate?.symbol).toBe("MYTOKEN");
  });
});
