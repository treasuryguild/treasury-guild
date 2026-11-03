import { describe, expect, it } from "vitest";
import type { MintWithTx } from "@/lib/db/types";
import { TxState } from "@/lib/constants";
import { buildMintRequest, nftAttributes } from "./buildMintRequest";
import { cip26DraftForMint, cip26FileName } from "./cip26";
import { lockedPoliciesFor } from "./lockedPolicies";
import {
  mintFormFromRow,
  reuseActionsFor,
  reuseBannerText,
  reuseModeFor,
} from "./reuseMint";
import { emptyMintForm, emptyNft, NEW_LOCK, type MintFormState } from "./types";
import { validateMintForm } from "./validateMintForm";

const NOW = Date.parse("2026-01-01T00:00:00Z");
const image = { cid: "Qm" + "1".repeat(44), mediaType: "image/png", fileName: "a.png", uploading: false, error: null };

function ftForm(over: Partial<MintFormState> = {}): MintFormState {
  return {
    ...emptyMintForm(),
    treasuryId: "t1",
    ftName: "GuildToken",
    ticker: "GVT",
    decimals: 6,
    supply: "1000",
    ftImage: image,
    ...over,
  };
}

describe("validateMintForm", () => {
  const ctx = { canMintHere: true, now: NOW };

  it("accepts a complete fungible form", () => {
    expect(validateMintForm(ftForm(), ctx)).toBeNull();
  });

  it("reports the first missing piece", () => {
    expect(validateMintForm(ftForm({ treasuryId: "" }), ctx)).toBe("Choose a treasury");
    expect(validateMintForm(ftForm(), { ...ctx, canMintHere: false })).toMatch(/Only signers/);
    expect(validateMintForm(ftForm({ supply: "0" }), ctx)).toBe("Enter the total supply");
    expect(validateMintForm(ftForm({ ftImage: { ...image, cid: null } }), ctx)).toBe("Upload a logo image");
  });

  it("validates NFT drafts individually", () => {
    const nft = { ...emptyNft(), name: "Badge", image };
    expect(validateMintForm(ftForm({ kind: "nft", nfts: [nft] }), ctx)).toBeNull();
    expect(validateMintForm(ftForm({ kind: "nft", nfts: [nft, nft] }), ctx)).toBe("NFT #2: duplicate name");
    expect(validateMintForm(ftForm({ kind: "nft", nfts: [{ ...nft, image: emptyNft().image }] }), ctx)).toBe(
      "NFT #1: upload an image",
    );
  });

  it("requires a lock date at least an hour out for new locked policies", () => {
    const soon = new Date(NOW + 10 * 60_000).toISOString();
    const later = new Date(NOW + 2 * 3_600_000).toISOString();
    expect(validateMintForm(ftForm({ policyMode: "locked", lockUntil: "" }), ctx)).toBe(
      "Choose when the policy locks",
    );
    expect(validateMintForm(ftForm({ policyMode: "locked", lockUntil: soon }), ctx)).toMatch(/one hour/);
    expect(validateMintForm(ftForm({ policyMode: "locked", lockUntil: later }), ctx)).toBeNull();
    expect(
      validateMintForm(ftForm({ policyMode: "locked", existingLock: "123", lockUntil: "" }), ctx),
    ).toBeNull();
  });
});

describe("buildMintRequest", () => {
  it("builds a fungible request with the policy input", () => {
    const body = buildMintRequest(ftForm({ policyMode: "locked", existingLock: "500" }));
    expect(body).toMatchObject({
      treasuryId: "t1",
      assetKind: "ft",
      ticker: "GVT",
      decimals: 6,
      supply: "1000",
      policy: { mode: "locked", lockSlot: 500 },
      recipient: undefined,
    });
    expect(body.assets[0]).toMatchObject({ name: "GuildToken", imageCid: image.cid });
  });

  it("builds an NFT request with trimmed traits and drops null image fields", () => {
    const nft = {
      ...emptyNft(),
      name: "Badge",
      image: { ...image, mediaType: null },
      attributes: [{ key: " rarity ", value: "rare " }, { key: "", value: "x" }],
    };
    expect(nftAttributes(nft)).toEqual({ rarity: "rare" });
    const body = buildMintRequest(ftForm({ kind: "nft", nfts: [nft], recipient: " addr1 " }));
    expect(body.assetKind).toBe("nft");
    expect(body.assets[0]).toEqual({
      name: "Badge",
      description: "",
      imageCid: image.cid,
      mediaType: undefined,
      attributes: { rarity: "rare" },
    });
    expect(body.recipient).toBe("addr1");
    expect(body.policy).toEqual({ mode: "treasury" });
  });

  it("serialises a new lock date as ISO", () => {
    const body = buildMintRequest(
      ftForm({ policyMode: "locked", existingLock: NEW_LOCK, lockUntil: "2026-06-01T12:00" }),
    );
    expect(body.policy).toEqual({
      mode: "locked",
      lockUntil: new Date("2026-06-01T12:00").toISOString(),
    });
  });
});

describe("lockedPoliciesFor", () => {
  it("lists distinct still-open locked policies of the treasury", () => {
    const mints = [
      { treasury_id: "t1", policy_id: "p1", lock_slot: 10, lock_until: new Date(NOW + 1000).toISOString() },
      { treasury_id: "t1", policy_id: "p1", lock_slot: 10, lock_until: new Date(NOW + 1000).toISOString() },
      { treasury_id: "t1", policy_id: "p2", lock_slot: 20, lock_until: new Date(NOW - 1000).toISOString() },
      { treasury_id: "t1", policy_id: "p3", lock_slot: null, lock_until: null },
      { treasury_id: "t2", policy_id: "p4", lock_slot: 30, lock_until: null },
    ];
    expect(lockedPoliciesFor(mints, "t1", NOW)).toEqual([
      { policyId: "p1", lockSlot: 10, lockUntil: mints[0]?.lock_until },
    ]);
  });
});

describe("CIP-26 registry draft", () => {
  const POLICY = "ab".repeat(28);
  function mintRow(over: Partial<MintWithTx> = {}): MintWithTx {
    return {
      id: "m1", transaction_id: "tx1", treasury_id: "t1", asset_kind: "ft",
      policy_id: POLICY, policy_script_cbor: "8200581c00", lock_slot: null, lock_until: null,
      asset_name: "GVT", asset_name_hex: "475654", quantity: "1000000", decimals: 6, ticker: "GVT",
      image_cid: null, recipient: "addr_test1recipient", created_at: "2026-09-01T00:00:00Z",
      metadata: { name: "Treasury Guild Token", description: "The community token", url: "https://guild.test" },
      transaction: { state: 2, tx_hash: "ff".repeat(32) },
      ...over,
    };
  }
  const unsigned = (value: unknown) => ({ value, sequenceNumber: 0, signatures: [] });

  it("names the file after the asset's unit", () => {
    expect(cip26FileName(mintRow())).toBe(`${POLICY}475654.json`);
    expect(cip26FileName({ policy_id: POLICY, asset_name_hex: "" })).toBe(`${POLICY}.json`);
  });

  it("builds the unsigned mapping from the mint row and its 721 metadata", () => {
    expect(cip26DraftForMint(mintRow(), "fallback", "bG9nbw==")).toEqual({
      subject: `${POLICY}475654`,
      policy: "8200581c00",
      name: unsigned("Treasury Guild Token"),
      description: unsigned("The community token"),
      ticker: unsigned("GVT"),
      decimals: unsigned(6),
      url: unsigned("https://guild.test"),
      logo: unsigned("bG9nbw=="),
    });
    // The subject is the unit the file is named after.
    expect(`${cip26DraftForMint(mintRow(), "").subject as string}.json`).toBe(cip26FileName(mintRow()));
  });

  it("joins chunked 721 strings back together", () => {
    const description = ["a".repeat(64), "b".repeat(10)];
    const draft = cip26DraftForMint(mintRow({ metadata: { name: ["Treasury ", "Guild"], description, url: ["https://guild", ".test"] } }), "fallback");
    expect(draft.name).toEqual(unsigned("Treasury Guild"));
    expect(draft.description).toEqual(unsigned(`${"a".repeat(64)}${"b".repeat(10)}`));
    expect(draft.url).toEqual(unsigned("https://guild.test"));
  });

  it("falls back to the asset name and the given description, and leaves out what the row lacks", () => {
    const draft = cip26DraftForMint(mintRow({ metadata: {}, ticker: null, decimals: 0 }), "Minted with Treasury Guild");
    expect(draft.name).toEqual(unsigned("GVT"));
    expect(draft.description).toEqual(unsigned("Minted with Treasury Guild"));
    expect(draft).not.toHaveProperty("ticker");
    expect(draft).not.toHaveProperty("url");
    expect(draft).not.toHaveProperty("logo");
    // Zero decimals is a statement, not an absence.
    expect(draft.decimals).toEqual(unsigned(0));
    // Metadata of the wrong shape or empty strings count as missing.
    const odd = cip26DraftForMint(mintRow({ metadata: { name: 42, description: "", url: { href: "x" } } }), "fallback");
    expect(odd.name).toEqual(unsigned("GVT"));
    expect(odd.description).toEqual(unsigned("fallback"));
    expect(odd).not.toHaveProperty("url");
  });

  it("caps the name at 50 and the description at 500 characters, as the registry does", () => {
    const draft = cip26DraftForMint(mintRow({ metadata: { name: "n".repeat(60), description: "d".repeat(600) } }), "");
    expect(draft.name).toEqual(unsigned("n".repeat(50)));
    expect(draft.description).toEqual(unsigned("d".repeat(500)));
  });
});

describe("reuseMint", () => {
  const POLICY = "ab".repeat(28);
  const CID = "Qm" + "2".repeat(44);

  function row(over: Partial<MintWithTx> = {}): MintWithTx {
    return {
      id: "m1",
      transaction_id: "tx1",
      treasury_id: "t1",
      asset_kind: "ft",
      policy_id: POLICY,
      policy_script_cbor: "8200581c00",
      lock_slot: null,
      lock_until: null,
      asset_name: "GuildToken",
      asset_name_hex: "4775696c64546f6b656e",
      quantity: "1000000000",
      decimals: 6,
      ticker: "GVT",
      image_cid: CID,
      recipient: "addr_test1recipient",
      created_at: "2026-09-01T00:00:00Z",
      metadata: {
        name: "GuildToken",
        description: "Community token",
        url: "https://guild.test",
        mediaType: "image/png",
        ticker: "GVT",
        decimals: 6,
        image: `ipfs://${CID}`,
      },
      transaction: { state: TxState.Confirmed, tx_hash: "ff".repeat(32) },
      ...over,
    };
  }

  it("offers nothing for unconfirmed mints", () => {
    expect(reuseModeFor(row({ transaction: { state: TxState.Pending, tx_hash: null } }), NOW)).toBeNull();
    expect(reuseActionsFor(row({ transaction: null }), NOW)).toBeNull();
  });

  it("offers mint more (+ template) for a confirmed open-policy FT", () => {
    expect(reuseActionsFor(row(), NOW)).toEqual({
      primary: "mint_more",
      secondary: "template",
    });
  });

  it("offers mint more while a locked FT policy is still live", () => {
    const live = row({
      lock_slot: 99,
      lock_until: new Date(NOW + 60_000).toISOString(),
    });
    expect(reuseModeFor(live, NOW)).toBe("mint_more");
  });

  it("falls back to template only once the lock has expired", () => {
    const expired = row({
      lock_slot: 99,
      lock_until: new Date(NOW - 60_000).toISOString(),
    });
    expect(reuseActionsFor(expired, NOW)).toEqual({ primary: "template" });
  });

  it("offers template only for NFTs", () => {
    expect(reuseActionsFor(row({ asset_kind: "nft", ticker: null }), NOW)).toEqual({
      primary: "template",
    });
  });

  it("prefills an FT mint-more with locked identity and empty supply", () => {
    const patch = mintFormFromRow(row(), "mint_more", NOW);
    expect(patch).toMatchObject({
      treasuryId: "t1",
      kind: "ft",
      ftName: "GuildToken",
      ticker: "GVT",
      decimals: 6,
      supply: "",
      ftDescription: "Community token",
      url: "https://guild.test",
      policyMode: "treasury",
      existingLock: NEW_LOCK,
      reuse: { mode: "mint_more", sourceName: "GuildToken", sourceTicker: "GVT" },
    });
    expect(patch.ftImage).toMatchObject({ cid: CID, mediaType: "image/png" });
  });

  it("keeps a live locked policy when minting more", () => {
    const patch = mintFormFromRow(
      row({ lock_slot: 42, lock_until: new Date(NOW + 60_000).toISOString() }),
      "mint_more",
      NOW,
    );
    expect(patch).toMatchObject({
      policyMode: "locked",
      existingLock: "42",
    });
  });

  it("resets an expired lock to an open policy for a template", () => {
    const patch = mintFormFromRow(
      row({ lock_slot: 42, lock_until: new Date(NOW - 60_000).toISOString() }),
      "template",
      NOW,
    );
    expect(patch).toMatchObject({
      policyMode: "treasury",
      existingLock: NEW_LOCK,
      reuse: { mode: "template" },
    });
  });

  it("clears the NFT name and copies traits for a template", () => {
    const patch = mintFormFromRow(
      row({
        asset_kind: "nft",
        ticker: null,
        asset_name: "Badge",
        metadata: {
          name: "Badge",
          description: "A badge",
          mediaType: "image/png",
          image: `ipfs://${CID}`,
          rarity: "legendary",
          series: "one",
        },
      }),
      "template",
      NOW,
    );
    expect(patch.kind).toBe("nft");
    expect(patch.nfts).toHaveLength(1);
    expect(patch.nfts![0]).toMatchObject({
      name: "",
      description: "A badge",
      image: { cid: CID, mediaType: "image/png" },
    });
    expect(patch.nfts![0]!.attributes).toEqual([
      { key: "rarity", value: "legendary" },
      { key: "series", value: "one" },
    ]);
    expect(patch.reuse).toEqual({
      mode: "template",
      sourceName: "Badge",
      sourceTicker: null,
    });
  });

  it("reads the image CID from metadata when the column is empty", () => {
    const patch = mintFormFromRow(
      row({ image_cid: null, metadata: { image: `ipfs://${CID}`, mediaType: "image/webp" } }),
      "mint_more",
      NOW,
    );
    expect(patch.ftImage).toMatchObject({ cid: CID, mediaType: "image/webp" });
  });

  it("describes the banner for mint-more and template", () => {
    expect(
      reuseBannerText(
        { mode: "mint_more", sourceName: "GuildToken", sourceTicker: "GVT" },
        "treasury",
      ),
    ).toMatch(/Minting more of GVT under the open treasury policy/);
    expect(
      reuseBannerText(
        { mode: "mint_more", sourceName: "GuildToken", sourceTicker: null },
        "locked",
      ),
    ).toMatch(/time-locked policy/);
    expect(
      reuseBannerText({ mode: "template", sourceName: "Badge", sourceTicker: null }, "treasury"),
    ).toMatch(/Template from Badge/);
  });
});
