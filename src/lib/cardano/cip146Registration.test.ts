import { describe, expect, it } from "vitest";
import { SignerGroup } from "@/lib/constants";
import {
  buildTreasuryLabel1854Metadata,
  chunkMetadataString,
  isRegistrationUpToDate,
  joinMetadataString,
  parseLabel1854Metadata,
  participantsInclude,
  participantsMatchExactly,
  truncateMetadataString,
  treasuryParticipantHashes,
} from "./cip146Registration";

const hashA = "a".repeat(56);
const hashB = "b".repeat(56);
const hashC = "c".repeat(56);
const stakeA = "1".repeat(56);
const drepA = "2".repeat(56);

function baseSigners() {
  return [
    {
      key_hash: hashA,
      stake_key_hash: null as string | null,
      drep_key_hash: null as string | null,
      display_name: "Alice",
      signer_group: SignerGroup.Base,
    },
    {
      key_hash: hashB,
      stake_key_hash: null,
      drep_key_hash: null,
      display_name: "Bob",
      signer_group: SignerGroup.Base,
    },
  ];
}

describe("parseLabel1854Metadata", () => {
  it("accepts a valid CIP-0146 payload", () => {
    expect(
      parseLabel1854Metadata({
        types: [0, 2],
        name: "Team",
        participants: { [hashA]: { name: "Alice" }, [hashB]: { name: "Bob" } },
      }),
    ).toEqual({
      types: [0, 2],
      name: "Team",
      participants: {
        [hashA]: { name: "Alice" },
        [hashB]: { name: "Bob" },
      },
    });
  });

  it("rejects payloads without types", () => {
    expect(parseLabel1854Metadata({ participants: { [hashA]: { name: "A" } } })).toBeNull();
  });
});

describe("chunkMetadataString", () => {
  it("returns the string unchanged when it fits in 64 bytes", () => {
    expect(chunkMetadataString("short name")).toBe("short name");
  });

  it("chunks long strings into <=64-byte pieces that round-trip", () => {
    const long = "x".repeat(200);
    const chunks = chunkMetadataString(long);
    expect(Array.isArray(chunks)).toBe(true);
    for (const chunk of chunks as string[]) {
      expect(new TextEncoder().encode(chunk).length).toBeLessThanOrEqual(64);
    }
    expect(joinMetadataString(chunks)).toBe(long);
  });

  it("chunks by byte length without splitting multi-byte characters", () => {
    const emoji = "🚀".repeat(40);
    const chunks = chunkMetadataString(emoji) as string[];
    expect(Array.isArray(chunks)).toBe(true);
    for (const chunk of chunks) {
      expect(new TextEncoder().encode(chunk).length).toBeLessThanOrEqual(64);
      expect(joinMetadataString([chunk])).toBe(chunk);
    }
    expect(joinMetadataString(chunks)).toBe(emoji);
  });
});

describe("truncateMetadataString", () => {
  it("truncates to at most 64 bytes on a character boundary", () => {
    const long = "é".repeat(50);
    const truncated = truncateMetadataString(long);
    expect(new TextEncoder().encode(truncated).length).toBeLessThanOrEqual(64);
    expect(truncated).toBe("é".repeat(32));
  });
});

describe("joinMetadataString", () => {
  it("passes strings through and joins arrays", () => {
    expect(joinMetadataString("abc")).toBe("abc");
    expect(joinMetadataString(["ab", "cd"])).toBe("abcd");
    expect(joinMetadataString(undefined)).toBe("");
    expect(joinMetadataString(42)).toBe("");
  });
});

describe("buildTreasuryLabel1854Metadata", () => {
  it("builds the CIP-0146 payload from base signers", () => {
    const payload = buildTreasuryLabel1854Metadata(
      { name: "Team Wallet" },
      baseSigners(),
      "Shared funds",
    );
    expect(payload.types).toEqual([0]);
    expect(payload.name).toBe("Team Wallet");
    expect(payload.description).toBe("Shared funds");
    expect(payload.participants).toEqual({
      [hashA]: { name: "Alice" },
      [hashB]: { name: "Bob" },
    });
  });

  it("includes recovery, cosigner, stake and DRep hashes", () => {
    const signers = [
      {
        key_hash: hashA,
        stake_key_hash: stakeA,
        drep_key_hash: drepA,
        display_name: "Alice",
        signer_group: SignerGroup.Base,
      },
      {
        key_hash: hashB,
        stake_key_hash: null,
        drep_key_hash: null,
        display_name: "Recovery",
        signer_group: SignerGroup.Recovery,
      },
      {
        key_hash: hashC,
        stake_key_hash: null,
        drep_key_hash: null,
        display_name: "Co",
        signer_group: SignerGroup.Cosigner,
      },
    ];
    const payload = buildTreasuryLabel1854Metadata({ name: "Clawback" }, signers);
    expect(payload.types).toEqual([0, 2, 3]);
    expect(Object.keys(payload.participants!).sort()).toEqual(
      [hashA, hashB, hashC, stakeA, drepA].sort(),
    );
    expect(payload.participants![stakeA]).toEqual({ name: "Alice" });
    expect(payload.participants![hashB]).toEqual({ name: "Recovery" });
  });

  it("chunks long name/description and truncates participant names", () => {
    const longName = "n".repeat(100);
    const payload = buildTreasuryLabel1854Metadata(
      { name: longName },
      [{
        key_hash: hashA,
        stake_key_hash: null,
        drep_key_hash: null,
        display_name: "p".repeat(100),
        signer_group: SignerGroup.Base,
      }],
      "d".repeat(150),
    );
    expect(Array.isArray(payload.name)).toBe(true);
    expect(joinMetadataString(payload.name)).toBe(longName);
    expect(Array.isArray(payload.description)).toBe(true);
    expect(payload.participants![hashA]!.name).toBe("p".repeat(64));
  });

  it("omits empty name and description", () => {
    const payload = buildTreasuryLabel1854Metadata(
      { name: "" },
      [{
        key_hash: hashA,
        stake_key_hash: null,
        drep_key_hash: null,
        display_name: "Alice",
        signer_group: SignerGroup.Base,
      }],
      "",
    );
    expect(payload.name).toBeUndefined();
    expect(payload.description).toBeUndefined();
  });
});

describe("treasuryParticipantHashes", () => {
  it("lists every group and role hash once", () => {
    expect(
      treasuryParticipantHashes([
        {
          key_hash: hashA,
          stake_key_hash: stakeA,
          drep_key_hash: drepA,
          signer_group: SignerGroup.Base,
        },
        {
          key_hash: hashB,
          stake_key_hash: "f".repeat(56),
          drep_key_hash: null,
          signer_group: SignerGroup.Recovery,
        },
      ]).sort(),
    ).toEqual([hashA, hashB, stakeA, drepA].sort());
  });
});

describe("participantsMatchExactly", () => {
  const item = {
    tx_hash: "1".repeat(64),
    json_metadata: {
      types: [0],
      participants: {
        [hashA.toUpperCase()]: { name: "Alice" },
        [hashB]: { name: "Bob" },
      },
    },
  };

  it("matches an identical participant set case-insensitively", () => {
    expect(participantsMatchExactly(item, [hashA, hashB])).toBe(true);
  });

  it("rejects subsets and supersets", () => {
    expect(participantsMatchExactly(item, [hashA])).toBe(false);
    expect(participantsMatchExactly(item, [hashA, hashB, hashC])).toBe(false);
  });

  it("rejects items without participants", () => {
    expect(participantsMatchExactly({ tx_hash: "2".repeat(64) }, [hashA])).toBe(false);
  });
});

describe("participantsInclude", () => {
  const item = {
    tx_hash: "1".repeat(64),
    json_metadata: {
      types: [0],
      participants: {
        [hashA.toUpperCase()]: { name: "Alice" },
        [hashB]: { name: "Bob" },
      },
    },
  };

  it("accepts subsets and the full set, case-insensitively", () => {
    expect(participantsInclude(item, [hashA])).toBe(true);
    expect(participantsInclude(item, [hashA.toUpperCase(), hashB])).toBe(true);
  });

  it("rejects supersets, empty queries and items without participants", () => {
    expect(participantsInclude(item, [hashA, hashB, hashC])).toBe(false);
    expect(participantsInclude(item, [])).toBe(false);
    expect(participantsInclude({ tx_hash: "2".repeat(64) }, [hashA])).toBe(false);
  });
});

describe("isRegistrationUpToDate", () => {
  it("recognizes matching on-chain metadata, including chunked strings", () => {
    const treasury = { name: "A Very Long Wallet Name" };
    const signers = baseSigners();
    const payload = buildTreasuryLabel1854Metadata(treasury, signers, "desc");
    const item = { tx_hash: "3".repeat(64), json_metadata: payload };
    expect(isRegistrationUpToDate(item, treasury, signers, "desc")).toBe(true);
  });

  it("detects a changed name", () => {
    const treasury = { name: "Team Wallet" };
    const signers = baseSigners();
    const payload = buildTreasuryLabel1854Metadata(treasury, signers, "Shared funds");
    const item = {
      tx_hash: "4".repeat(64),
      json_metadata: { ...payload, name: "Old Name" },
    };
    expect(isRegistrationUpToDate(item, treasury, signers, "Shared funds")).toBe(false);
  });

  it("detects a changed participant name", () => {
    const treasury = { name: "Team Wallet" };
    const signers = baseSigners();
    const item = {
      tx_hash: "5".repeat(64),
      json_metadata: {
        types: [0],
        name: "Team Wallet",
        description: "Shared funds",
        participants: {
          [hashA]: { name: "Alice" },
          [hashB]: { name: "Robert" },
        },
      },
    };
    expect(isRegistrationUpToDate(item, treasury, signers, "Shared funds")).toBe(false);
  });
});
