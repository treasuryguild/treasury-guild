import { describe, expect, it } from "vitest";
import { DrepAction, StakeAction, TxKind } from "@/lib/constants";
import {
  classifyExternalActivity,
  externalActivityDetail,
  externalActivityTitle,
  isRecognizedExternalActivity,
  parseExternalActivity,
} from "./externalActivity";

describe("classifyExternalActivity", () => {
  it("recognizes CIP-0146 registration from label 1854", () => {
    expect(
      classifyExternalActivity({
        metadata: { "1854": { types: [1], name: "Gov Treasury" } },
      }),
    ).toEqual({ kind: TxKind.Registration });
  });

  it("recognizes an anchor record from label 190002", () => {
    expect(
      classifyExternalActivity({
        metadata: {
          "190002": {
            v: 1,
            src: "treasury-guild",
            c: "signius",
            a: [[3, "proposed", "a".repeat(64), "b".repeat(64)]],
          },
        },
      }),
    ).toEqual({ kind: TxKind.Anchor, proposalNumbers: [3] });
  });

  it("recognizes the phase-0 anchor test record", () => {
    expect(
      classifyExternalActivity({
        metadata: { "190002": { v: 1, src: "treasury-guild", c: "signius", test: 1 } },
      }),
    ).toEqual({ kind: TxKind.Anchor });
  });

  it("combines stake_registration + pool_delegation into register_and_delegate", () => {
    expect(
      classifyExternalActivity({
        certificates: [
          { index: 0, type: "stake_registration", info: { stake_address: "stake1…" } },
          {
            index: 1,
            type: "pool_delegation",
            info: { pool_id_bech32: "pool1angel", stake_address: "stake1…" },
          },
        ],
      }),
    ).toEqual({
      kind: TxKind.Stake,
      action: StakeAction.RegisterAndDelegate,
      poolId: "pool1angel",
    });
  });

  it("classifies vote_delegation with the DRep id", () => {
    expect(
      classifyExternalActivity({
        certificates: [
          {
            index: 0,
            type: "vote_delegation",
            info: { drep_id: "drep1medusa", stake_address: "stake1…" },
          },
        ],
      }),
    ).toEqual({
      kind: TxKind.Stake,
      action: StakeAction.VoteDelegation,
      dRepId: "drep1medusa",
    });
  });

  it("classifies a plain pool delegation and a deregistration", () => {
    expect(
      classifyExternalActivity({
        certificates: [
          { index: 0, type: "pool_delegation", info: { pool_id_bech32: "pool1x" } },
        ],
      }),
    ).toMatchObject({ kind: TxKind.Stake, action: StakeAction.Delegate, poolId: "pool1x" });
    expect(
      classifyExternalActivity({
        certificates: [{ index: 0, type: "stake_deregistration", info: {} }],
      }),
    ).toEqual({ kind: TxKind.Stake, action: StakeAction.Deregister });
  });

  it("classifies DRep certificates and withdrawals", () => {
    expect(
      classifyExternalActivity({
        certificates: [
          { index: 0, type: "drep_registration", info: { drep_id: "drep1abc" } },
        ],
      }),
    ).toEqual({ kind: TxKind.Drep, action: DrepAction.Register, dRepId: "drep1abc" });
    expect(
      classifyExternalActivity({
        withdrawals: [{ amount: "1500000", stake_addr: "stake1…" }],
      }),
    ).toEqual({ kind: TxKind.Stake, action: StakeAction.Withdraw });
  });

  it("classifies governance votes", () => {
    expect(
      classifyExternalActivity({
        voting_procedures: [
          { voter: "drep1abc", vote: "Yes", proposal_tx_hash: "a".repeat(64) },
          { voter: "drep1abc", vote: "No", proposal_tx_hash: "b".repeat(64) },
        ],
      }),
    ).toEqual({ kind: TxKind.Vote, dRepId: "drep1abc", voteCount: 2 });
  });

  it("ignores label 190001 and returns null for an opaque transfer", () => {
    expect(
      classifyExternalActivity({
        metadata: { "190001": { v: 3, src: "treasury-guild", p: [] } },
      }),
    ).toBeNull();
    expect(classifyExternalActivity({ metadata: null, certificates: [] })).toBeNull();
  });

  it("prefers registration metadata over certificates on the same tx", () => {
    expect(
      classifyExternalActivity({
        metadata: { "1854": { types: [1] } },
        certificates: [
          { index: 0, type: "stake_registration", info: {} },
        ],
      }),
    ).toEqual({ kind: TxKind.Registration });
  });
});

describe("externalActivityTitle / detail", () => {
  it("matches app-built stake and registration titles", () => {
    expect(
      externalActivityTitle({
        kind: TxKind.Stake,
        action: StakeAction.VoteDelegation,
        dRepName: "Medusa DRep",
      }),
    ).toBe("Stake: vote delegation to Medusa DRep");
    expect(
      externalActivityTitle({
        kind: TxKind.Stake,
        action: StakeAction.RegisterAndDelegate,
        poolTicker: "ANGEL",
      }),
    ).toBe("Stake: register and delegate to ANGEL");
    expect(externalActivityTitle({ kind: TxKind.Registration })).toBe(
      "CIP-0146 wallet registration",
    );
    expect(externalActivityDetail({ kind: TxKind.Registration })).toBe("CIP-0146 registration");
  });
});

describe("parseExternalActivity / isRecognizedExternalActivity", () => {
  it("round-trips stored jsonb and rejects junk", () => {
    const stake = {
      kind: TxKind.Stake,
      action: StakeAction.Delegate,
      poolId: "pool1x",
    };
    expect(parseExternalActivity(stake)).toEqual({
      ...stake,
      poolTicker: null,
      dRepId: null,
      dRepName: null,
    });
    expect(parseExternalActivity({ kind: "nope" })).toBeNull();
    expect(parseExternalActivity(null)).toBeNull();
    expect(isRecognizedExternalActivity(parseExternalActivity(stake))).toBe(true);
    expect(isRecognizedExternalActivity(null)).toBe(false);
  });
});
