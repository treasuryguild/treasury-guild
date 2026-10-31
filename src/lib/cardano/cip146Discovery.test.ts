import { describe, expect, it } from "vitest";
import {
  filterRegistrationsByHashes,
  lookupItemsFromMetadata,
} from "./cip146Discovery";

const hashA = "a".repeat(56);
const hashB = "b".repeat(56);
const hashC = "c".repeat(56);

describe("lookupItemsFromMetadata", () => {
  it("reads label 1854 rows and skips empty participants", () => {
    const byHash = new Map<string, Record<string, unknown>>([
      [
        "1".repeat(64),
        {
          "1854": {
            types: [0],
            participants: { [hashA]: { name: "Alice" } },
          },
        },
      ],
      ["2".repeat(64), { "1854": { types: [0] } }],
    ]);
    expect(lookupItemsFromMetadata(byHash)).toEqual([
      {
        tx_hash: "1".repeat(64),
        json_metadata: {
          types: [0],
          participants: { [hashA]: { name: "Alice" } },
        },
      },
    ]);
  });
});

describe("filterRegistrationsByHashes", () => {
  const items = [
    {
      tx_hash: "1".repeat(64),
      json_metadata: {
        types: [0],
        participants: { [hashA]: { name: "A" }, [hashB]: { name: "B" } },
      },
    },
    {
      tx_hash: "2".repeat(64),
      json_metadata: {
        types: [0],
        participants: { [hashC]: { name: "C" } },
      },
    },
  ];

  it("keeps registrations that share any queried hash", () => {
    expect(filterRegistrationsByHashes(items, [hashA]).map((i) => i.tx_hash)).toEqual([
      "1".repeat(64),
    ]);
    expect(filterRegistrationsByHashes(items, [hashC, hashA])).toHaveLength(2);
  });
});
