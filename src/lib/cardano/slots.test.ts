import { describe, expect, it } from "vitest";
import { slotAt, slotTime } from "./slots";

describe("slots", () => {
  it("round-trips a moment through its slot on both networks", () => {
    const ms = Date.UTC(2027, 2, 1, 12, 0, 0);
    for (const network of [0, 1] as const) {
      const slot = slotAt(network, ms);
      expect(Number.isInteger(slot)).toBe(true);
      // Slots are one second on both networks: the slot begins within a second of the moment.
      expect(Math.abs(Date.parse(slotTime(network, slot)) - ms)).toBeLessThan(1000);
      expect(slotAt(network, Date.parse(slotTime(network, slot)))).toBe(slot);
    }
  });

  it("gives different slots per network for the same moment", () => {
    const ms = Date.UTC(2027, 2, 1);
    expect(slotAt(0, ms)).not.toBe(slotAt(1, ms));
  });

  it("is monotonic", () => {
    const ms = Date.UTC(2027, 2, 1);
    expect(slotAt(0, ms + 60_000)).toBe(slotAt(0, ms) + 60);
  });
});
