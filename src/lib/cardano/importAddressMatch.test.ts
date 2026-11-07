import { describe, expect, it } from "vitest";
import { matchImportAddresses } from "./importAddressMatch";

const hashA = "a".repeat(56);
const hashB = "b".repeat(56);
const hashC = "c".repeat(56);
const addrA = "addr_test1qqaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const addrB = "addr_test1qqbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";
const addrC = "addr_test1qqcccccccccccccccccccccccccccccccccccccccccccccccccc";
const addrWrong = "addr_test1qqdddddddddddddddddddddddddddddddddddddddddddddddddd";

const emptySlots = [
  { keyHash: hashA, address: null },
  { keyHash: hashB, address: null },
];

describe("matchImportAddresses", () => {
  it("assigns addresses in any order to their key-hash slots", () => {
    expect(
      matchImportAddresses(emptySlots, [
        { address: addrB, keyHash: hashB },
        { address: addrA, keyHash: hashA },
      ]),
    ).toEqual({
      assignments: [
        { keyHash: hashB, address: addrB },
        { keyHash: hashA, address: addrA },
      ],
      problems: [],
    });
  });

  it("allows a partial fill when some slots stay empty", () => {
    expect(
      matchImportAddresses(emptySlots, [{ address: addrA, keyHash: hashA }]),
    ).toEqual({
      assignments: [{ keyHash: hashA, address: addrA }],
      problems: [],
    });
  });

  it("skips an address that already claims its slot", () => {
    expect(
      matchImportAddresses(
        [
          { keyHash: hashA, address: addrA },
          { keyHash: hashB, address: null },
        ],
        [
          { address: addrA, keyHash: hashA },
          { address: addrB, keyHash: hashB },
        ],
      ),
    ).toEqual({
      assignments: [{ keyHash: hashB, address: addrB }],
      problems: [],
    });
  });

  it("refuses a key not in the script and applies nothing", () => {
    const result = matchImportAddresses(emptySlots, [
      { address: addrA, keyHash: hashA },
      { address: addrWrong, keyHash: hashC },
    ]);
    expect(result.assignments).toEqual([]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatch(/not a signer of this script/);
  });

  it("refuses a duplicate key in the paste list and applies nothing", () => {
    const result = matchImportAddresses(emptySlots, [
      { address: addrA, keyHash: hashA },
      { address: addrC, keyHash: hashA },
    ]);
    expect(result.assignments).toEqual([]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatch(/listed more than once/);
  });

  it("refuses a different address for an already-claimed slot", () => {
    const result = matchImportAddresses(
      [
        { keyHash: hashA, address: addrA },
        { keyHash: hashB, address: null },
      ],
      [{ address: addrC, keyHash: hashA }],
    );
    expect(result.assignments).toEqual([]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatch(/conflicts with an already claimed signer/);
  });

  it("compares key hashes case-insensitively", () => {
    expect(
      matchImportAddresses(emptySlots, [
        { address: addrA, keyHash: hashA.toUpperCase() },
      ]),
    ).toEqual({
      assignments: [{ keyHash: hashA, address: addrA }],
      problems: [],
    });
  });
});
