// End-to-end check of the signing invariants (CLAUDE.md "core-cst only for
// tx bytes"): a tx built by our builders, partially signed by a throwaway
// wallet, merged and filtered server-side must keep the exact body hash the
// wallet signed. No network: the provider is a stub with fixed UTxOs.
import { beforeAll, describe, expect, it } from "vitest";
import { DEFAULT_PROTOCOL_PARAMETERS, type IFetcher, type UTxO } from "@meshsdk/common";
import { MeshWallet, resolveNativeScriptHash, serializeNativeScript } from "@meshsdk/core";
import { resolveTxHash } from "@meshsdk/core-cst";
import { paymentKeyHash, MultisigWallet } from "./multisigSDK";
import { buildPayoutTx } from "./payoutBuilder";
import { buildMintTx } from "./mintBuilder";
import { utf8ToHex } from "./cip25";
import { buildCip25Metadata, mintPolicyScript } from "./mintMetadata";
import {
  decodeTxFee,
  decodeTxForDisplay,
  decodeTxMint,
  decodeTxOutputs,
  decodeTxTtl,
  extractAnchorMetadata,
  extractCip25Metadata,
  extractPayoutMetadata,
  extractTxMessage,
} from "./cborMetadata";
import { buildAnchorMetadata, parseAnchorMetadata, type AnchorEntry } from "./anchorMetadata";
import { filterWitnessesToScripts, mergeSignerWitnesses, witnessKeyHashes } from "./txSignUtils";
import { joinUnit } from "./units";

const RECIPIENT =
  "addr_test1qp86rhgehcs4k99rpu48879jncjmeytlhv4nxfd3sw2def6xxu4ylafkwgp2ad5l74sa3s75ttr3enxg2ps2qtrpanyswgshl2";

function stubFetcher(address: string, lovelace: string): IFetcher {
  const utxos: UTxO[] = [
    {
      input: { txHash: "a".repeat(64), outputIndex: 0 },
      output: { address, amount: [{ unit: "lovelace", quantity: lovelace }] },
    },
  ];
  return {
    fetchAddressUTxOs: async () => utxos,
    fetchProtocolParameters: async () => DEFAULT_PROTOCOL_PARAMETERS,
  } as unknown as IFetcher;
}

async function throwawayWallet(fetcher: IFetcher) {
  const words = MeshWallet.brew() as string[];
  const wallet = new MeshWallet({
    networkId: 0,
    fetcher,
    key: { type: "mnemonic", words },
  });
  await wallet.init();
  const address = await wallet.getChangeAddress();
  return { wallet, keyHash: paymentKeyHash(address) };
}

describe("signing path", () => {
  let signer: Awaited<ReturnType<typeof throwawayWallet>>;
  let stranger: Awaited<ReturnType<typeof throwawayWallet>>;
  let treasury: { address: string; scriptCbor: string };
  let provider: IFetcher;
  let multisig: MultisigWallet;

  beforeAll(async () => {
    const bootstrap = stubFetcher(RECIPIENT, "0");
    signer = await throwawayWallet(bootstrap);
    stranger = await throwawayWallet(bootstrap);
    // 1-of-1 treasury whose only signer is the throwaway wallet.
    multisig = new MultisigWallet(
      "Test",
      [{ keyHash: signer.keyHash, role: 0, name: "" }],
      "",
      1,
      0,
    );
    const script = multisig.getScript();
    treasury = { address: script.address, scriptCbor: script.scriptCbor! };
    provider = stubFetcher(treasury.address, "100000000");
  }, 60_000);

  it("payout: witnesses merge without changing the signed body hash", async () => {
    const built = await buildPayoutTx({
      treasuryAddress: treasury.address,
      scriptCbor: treasury.scriptCbor,
      communitySlug: "test-dao",
      network: 0,
      provider,
      recipients: [
        {
          contributorWallet: RECIPIENT,
          tasks: [
            {
              taskId: "t1",
              taskNumber: 12,
              workgroupName: "Dev",
              budgetPeriod: "2026-Q3",
              amounts: [{ unit: "lovelace", quantity: 5_000_000n }],
              citations: [],
            },
          ],
        },
      ],
    });
    expect(built.txHash).toBe(resolveTxHash(built.unsignedTxHex));

    const signed = await signer.wallet.signTx(built.unsignedTxHex, true);
    const merged = mergeSignerWitnesses(built.unsignedTxHex, signed);
    expect(merged.invalidVkeyPubKeysHex).toEqual([]);
    expect(merged.addedKeyHashes).toContain(signer.keyHash.toLowerCase());
    expect(resolveTxHash(merged.txHex)).toBe(built.txHash);

    // Re-merging the same witness is a no-op; filtering keeps the required key.
    expect(mergeSignerWitnesses(merged.txHex, signed).addedKeyHashes).toEqual([]);
    expect(filterWitnessesToScripts(merged.txHex)).toBe(merged.txHex);

    // Decoding from CBOR shows the recipient output and the v3 metadata.
    const view = decodeTxForDisplay(built.unsignedTxHex);
    const out = view.outputs.find((o) => o.address === RECIPIENT);
    expect(out?.lovelace).toBe("5000000");
    expect(view.message).toMatch(/^Guild Vault payout: test-dao/);
    const meta = extractPayoutMetadata(built.unsignedTxHex) as {
      v: number;
      c: string;
      w: string[];
      b: string[];
      k: string[];
      p: unknown[];
    };
    expect(meta.v).toBe(3);
    expect(meta.c).toBe("test-dao");
    expect("n" in meta).toBe(false);
    expect(meta.w).toEqual(["Dev"]);
    expect(meta.b).toEqual(["2026-Q3"]);
    expect(meta.k).toEqual(["ADA"]);
    // The entry's output index must point at the output that pays the
    // recipient â€” this pins the builder's output-order guarantee.
    const outputIndex = view.outputs.findIndex((o) => o.address === RECIPIENT);
    expect(outputIndex).toBeGreaterThanOrEqual(0);
    expect(meta.p).toEqual([[outputIndex, [[12, 0, 0, ["5"]]]]]);
    expect(extractTxMessage(built.unsignedTxHex)).toBe(view.message);
    expect(decodeTxOutputs(built.unsignedTxHex).length).toBe(view.outputs.length);
  }, 60_000);

  it("payout: extraneous witnesses from a non-signer are stripped before submit", async () => {
    const built = await buildPayoutTx({
      treasuryAddress: treasury.address,
      scriptCbor: treasury.scriptCbor,
      communitySlug: "test-dao",
      network: 0,
      provider,
      recipients: [
        {
          contributorWallet: RECIPIENT,
          tasks: [{
            taskId: "t",
            taskNumber: 2,
            workgroupName: "Dev",
            budgetPeriod: "2026-Q3",
            amounts: [{ unit: "lovelace", quantity: 2_000_000n }],
            citations: [],
          }],
        },
      ],
    });
    const strangerSigned = await stranger.wallet.signTx(built.unsignedTxHex, true);
    const merged = mergeSignerWitnesses(built.unsignedTxHex, strangerSigned);
    // A stranger's signature is cryptographically valid, just not required.
    expect(merged.invalidVkeyPubKeysHex).toEqual([]);
    expect(merged.addedKeyHashes).not.toContain(signer.keyHash.toLowerCase());
    const filtered = filterWitnessesToScripts(merged.txHex);
    expect(filtered).not.toBe(merged.txHex);
    expect(resolveTxHash(filtered)).toBe(built.txHash);
    expect(filterWitnessesToScripts(filtered)).toBe(filtered);
  }, 60_000);

  it("mint: the forge policy is the treasury script and 721 metadata decodes", async () => {
    const paymentScript = multisig.buildScript(0)!;
    const forgeScript = mintPolicyScript(paymentScript, null);
    const policyId = resolveNativeScriptHash(forgeScript);
    const { scriptCbor: forgeScriptCbor } = serializeNativeScript(forgeScript, undefined, 0, true);
    const nameHex = utf8ToHex("GVT");
    const metadata721 = buildCip25Metadata(policyId, [
      { assetName: "GVT", image: "ipfs://cid", ticker: "GVT", decimals: 0 },
    ]);

    const built = await buildMintTx({
      treasuryAddress: treasury.address,
      spendScriptCbor: treasury.scriptCbor,
      forgeScriptCbor: forgeScriptCbor!,
      policyId,
      network: 0,
      provider,
      assets: [{ assetNameHex: nameHex, quantity: 1000n }],
      recipient: RECIPIENT,
      metadata721,
      message: "Guild Vault mint: test",
      lockSlot: null,
    });

    const mint = decodeTxMint(built.unsignedTxHex);
    expect(mint).toEqual([
      { unit: joinUnit(policyId, nameHex), policyId, assetNameHex: nameHex, quantity: "1000" },
    ]);
    const view = decodeTxForDisplay(built.unsignedTxHex);
    expect((view.cip25Meta as Record<string, unknown>)[policyId]).toBeTruthy();
    expect(policyId).toBe(resolveNativeScriptHash(paymentScript));

    const signed = await signer.wallet.signTx(built.unsignedTxHex, true);
    const merged = mergeSignerWitnesses(built.unsignedTxHex, signed);
    expect(merged.invalidVkeyPubKeysHex).toEqual([]);
    expect(resolveTxHash(merged.txHex)).toBe(built.txHash);
  }, 60_000);


  /** A one-task payout of `lovelace` to RECIPIENT from the test treasury. */
  function buildTestPayout(lovelace: bigint) {
    return buildPayoutTx({
      treasuryAddress: treasury.address,
      scriptCbor: treasury.scriptCbor,
      communitySlug: "test-dao",
      network: 0,
      provider,
      recipients: [
        {
          contributorWallet: RECIPIENT,
          tasks: [{
            taskId: "t",
            taskNumber: 3,
            workgroupName: "Dev",
            budgetPeriod: "2026-09",
            amounts: [{ unit: "lovelace", quantity: lovelace }],
            citations: [],
          }],
        },
      ],
    });
  }

  it("witnessKeyHashes: lists who signed, in witness order, and nobody for an unsigned tx", async () => {
    const built = await buildTestPayout(3_000_000n);
    expect(witnessKeyHashes(built.unsignedTxHex)).toEqual([]);

    const signerKey = signer.keyHash.toLowerCase();
    const strangerKey = stranger.keyHash.toLowerCase();
    const signed = mergeSignerWitnesses(built.unsignedTxHex, await signer.wallet.signTx(built.unsignedTxHex, true));
    expect(witnessKeyHashes(signed.txHex)).toEqual([signerKey]);
    // The same hashes mergeSignerWitnesses reported adding.
    expect(witnessKeyHashes(signed.txHex)).toEqual(signed.addedKeyHashes);

    const both = mergeSignerWitnesses(signed.txHex, await stranger.wallet.signTx(built.unsignedTxHex, true));
    expect(witnessKeyHashes(both.txHex).sort()).toEqual([signerKey, strangerKey].sort());
    // Re-merging a witness never lists a key twice.
    const again = mergeSignerWitnesses(both.txHex, await signer.wallet.signTx(built.unsignedTxHex, true));
    expect(witnessKeyHashes(again.txHex)).toHaveLength(2);

    // After the pre-submit filter only the script's own signer is left.
    expect(witnessKeyHashes(filterWitnessesToScripts(both.txHex))).toEqual([signerKey]);
    for (const hash of witnessKeyHashes(both.txHex)) expect(hash).toMatch(/^[0-9a-f]{56}$/);

    expect(() => witnessKeyHashes("not-cbor")).toThrow();
  }, 60_000);

  it("fee and TTL: read from the body; a payout has no TTL, a time-locked mint expires at its lock slot", async () => {
    const built = await buildTestPayout(4_000_000n);
    const fee = decodeTxFee(built.unsignedTxHex);
    expect(fee).toMatch(/^[1-9]\d*$/);
    // The one input holds 100 ADA: what does not come back out is the fee.
    const paidOut = decodeTxOutputs(built.unsignedTxHex).reduce((sum, o) => sum + BigInt(o.lovelace), 0n);
    expect(BigInt(fee!)).toBe(100_000_000n - paidOut);
    expect(decodeTxTtl(built.unsignedTxHex)).toBeUndefined();
    // Signing changes neither.
    const signed = mergeSignerWitnesses(built.unsignedTxHex, await signer.wallet.signTx(built.unsignedTxHex, true));
    expect(decodeTxFee(signed.txHex)).toBe(fee);
    expect(decodeTxTtl(signed.txHex)).toBeUndefined();
    expect(decodeTxForDisplay(built.unsignedTxHex)).toMatchObject({ fee, ttl: null, cip25Meta: null });
    // A payout carries no 721 record.
    expect(extractCip25Metadata(built.unsignedTxHex)).toBeUndefined();

    const lockSlot = 123_456_789;
    const forgeScript = mintPolicyScript(multisig.buildScript(0)!, lockSlot);
    const policyId = resolveNativeScriptHash(forgeScript);
    const { scriptCbor: forgeScriptCbor } = serializeNativeScript(forgeScript, undefined, 0, true);
    const metadata721 = buildCip25Metadata(policyId, [
      { assetName: "GVT", name: "Guild Vault Token", image: "ipfs://cid", mediaType: "image/png", ticker: "GVT", decimals: 2, attributes: { Rarity: "common" } },
      { assetName: "LONG", image: "ipfs://cid", description: "d".repeat(150) },
    ]);
    const mint = await buildMintTx({
      treasuryAddress: treasury.address,
      spendScriptCbor: treasury.scriptCbor,
      forgeScriptCbor: forgeScriptCbor!,
      policyId,
      network: 0,
      provider,
      assets: [{ assetNameHex: utf8ToHex("GVT"), quantity: 1000n }, { assetNameHex: utf8ToHex("LONG"), quantity: 1n }],
      recipient: RECIPIENT,
      metadata721,
      message: "Guild Vault mint: test",
      lockSlot,
    });
    expect(decodeTxTtl(mint.unsignedTxHex)).toBe(String(lockSlot));
    expect(decodeTxFee(mint.unsignedTxHex)).toMatch(/^[1-9]\d*$/);
    expect(decodeTxForDisplay(mint.unsignedTxHex).ttl).toBe(String(lockSlot));
    // The time lock makes it another policy than the bare treasury script.
    expect(policyId).not.toBe(resolveNativeScriptHash(multisig.buildScript(0)!));

    // The 721 record decodes to exactly what the builder was given, chunked strings included.
    const decoded = extractCip25Metadata(mint.unsignedTxHex);
    expect(decoded).toEqual(metadata721);
    const entries = (decoded as Record<string, Record<string, Record<string, unknown>>>)[policyId]!;
    expect(entries.GVT).toEqual({ name: "Guild Vault Token", image: "ipfs://cid", mediaType: "image/png", ticker: "GVT", decimals: 2, Rarity: "common" });
    expect(entries.LONG!.description).toEqual(["d".repeat(64), "d".repeat(64), "d".repeat(22)]);
    expect(decodeTxForDisplay(mint.unsignedTxHex).cip25Meta).toEqual(metadata721);
    // A mint is not a payout.
    expect(extractPayoutMetadata(mint.unsignedTxHex)).toBeUndefined();
  }, 60_000);

  it("payout: due anchors ride under label 190002 and read back from the CBOR", async () => {
    const entry: AnchorEntry = [4, "proposed", "a".repeat(64), "b".repeat(64)];
    const payout = (anchors: { n: number; entry: AnchorEntry }[]) => buildPayoutTx({
      treasuryAddress: treasury.address,
      scriptCbor: treasury.scriptCbor,
      communitySlug: "test-dao",
      network: 0,
      provider,
      recipients: [{
        contributorWallet: RECIPIENT,
        tasks: [{
          taskId: "t1", taskNumber: 12, workgroupName: "Dev", budgetPeriod: "2026-Q3",
          amounts: [{ unit: "lovelace", quantity: 5_000_000n }], citations: [],
        }],
      }],
      anchors,
    });

    const built = await payout([{ n: 4, entry }]);
    expect(built.anchorsCarried).toEqual([{ n: 4, entry }]);
    const record = extractAnchorMetadata(built.unsignedTxHex);
    expect(record).toEqual(buildAnchorMetadata("test-dao", [entry]));
    expect(parseAnchorMetadata(record)?.a).toEqual([entry]);
    // The payout record sits beside it, untouched.
    expect((extractPayoutMetadata(built.unsignedTxHex) as { v: number }).v).toBe(3);

    // Nothing due: no 190002 label at all.
    expect(extractAnchorMetadata((await payout([])).unsignedTxHex)).toBeUndefined();
  }, 60_000);

  it("fee, TTL and 721 metadata are undefined for bytes that are not a transaction", () => {
    for (const garbage of ["", "not-cbor", "00", "84a0"]) {
      expect(decodeTxFee(garbage), garbage).toBeUndefined();
      expect(decodeTxTtl(garbage), garbage).toBeUndefined();
      expect(extractCip25Metadata(garbage), garbage).toBeUndefined();
      expect(extractAnchorMetadata(garbage), garbage).toBeUndefined();
    }
  });
});
