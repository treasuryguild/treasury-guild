import {
  resolveNativeScriptHash,
  resolveSlotNo,
  serializeNativeScript,
} from "@meshsdk/core";
import { parseJson, sessionRoute } from "@/lib/api/route";
import { buildMintSchema, HTTP_URL_RE, IMAGE_MIME_RE, MAX_NFTS_PER_TX, type BuildMintBody } from "@/lib/api/schemas";
import type { BuildMintResponse } from "@/lib/api/types";
import { formatQuantity, scaleDecimal } from "@/lib/assets";
import { buildMintTx, type MintAssetSpec } from "@/lib/cardano/mintBuilder";
import {
  CID_RE,
  buildCip25Metadata,
  mintPolicyScript,
  validateAssetName,
  validateTicker,
  type Cip25Asset,
} from "@/lib/cardano/mintMetadata";
import { addressToNetwork, checkValidAddress } from "@/lib/cardano/multisigSDK";
import { getProvider } from "@/lib/cardano/provider";
import { joinUnit } from "@/lib/cardano/units";
import { networkName, type Network } from "@/lib/config";
import { MIN_LOCK_LEAD_MS, TxKind } from "@/lib/constants";
import { insertMints, loadLockedPolicy } from "@/lib/db/mints";
import { assertNoPendingTx, withTransactionRow } from "@/lib/db/transactions";
import { BadRequestError, errorMessage, InvariantError } from "@/lib/errors";
import { plural } from "@/lib/format";
import { resolveTreasury } from "@/lib/treasury";
import { loadBuildContext, requirePathBuilder, resolveSpendingPath, validFromSlotFor } from "@/lib/tx";



interface PolicyLock {
  lockSlot: number | null;
  lockUntil: string | null;
}

/** Resolve the requested policy: open treasury script, or time-lock wrapped. */
async function resolvePolicyLock(
  policy: BuildMintBody["policy"],
  network: Network,
  communityId: string,
  treasuryId: string,
): Promise<PolicyLock> {
  if (policy?.mode !== "locked") return { lockSlot: null, lockUntil: null };

  const nowSlot = Number(resolveSlotNo(networkName(network), Date.now()));
  let lockSlot: number;
  let lockUntil: string | null;
  if (typeof policy.lockSlot === "number") {
    // Continue a previously used locked policy of this community.
    lockSlot = Math.floor(policy.lockSlot);
    const prior = await loadLockedPolicy(communityId, treasuryId, lockSlot);
    if (!prior) throw new BadRequestError("Unknown locked policy for this treasury");
    lockUntil = prior.lock_until;
  } else if (policy.lockUntil) {
    const ms = Date.parse(policy.lockUntil);
    if (!Number.isFinite(ms)) throw new BadRequestError("Invalid lockUntil date");
    if (ms < Date.now() + MIN_LOCK_LEAD_MS) {
      throw new BadRequestError("Policy lock must be at least one hour in the future");
    }
    lockSlot = Number(resolveSlotNo(networkName(network), ms));
    lockUntil = new Date(ms).toISOString();
  } else {
    throw new BadRequestError("Locked policy needs lockUntil or lockSlot");
  }
  if (!Number.isInteger(lockSlot) || lockSlot <= nowSlot) {
    throw new BadRequestError("This policy is already locked; it cannot mint any more");
  }
  return { lockSlot, lockUntil };
}

export const POST = sessionRoute(async (req, { session }) => {
  const { wallet } = session;
  const body = await parseJson(req, buildMintSchema);
  const { treasuryId, assetKind, assets: assetInputs } = body;
  if (assetKind === "ft" && assetInputs.length !== 1) {
    throw new BadRequestError("A fungible mint defines exactly one asset");
  }
  if (assetKind === "nft" && assetInputs.length > MAX_NFTS_PER_TX) {
    throw new BadRequestError(`At most ${MAX_NFTS_PER_TX} NFTs per transaction`);
  }

  const ctx = await loadBuildContext(treasuryId, wallet);
  const { treasury, signers, network } = ctx;
  const path = resolveSpendingPath(ctx, body.path, TxKind.Mint);
  requirePathBuilder(ctx, path, "Only community admins or treasury signers can start a mint");
  await assertNoPendingTx(treasuryId);

  // ---- recipient
  const recipient = (body.recipient ?? "").trim() || treasury.address;
  if (!checkValidAddress(recipient)) {
    throw new BadRequestError("Invalid recipient address");
  }
  if (addressToNetwork(recipient) !== network) {
    throw new BadRequestError("Recipient address is on a different network");
  }

  // ---- policy (open treasury script, or time-lock wrapped)
  const { lockSlot, lockUntil } = await resolvePolicyLock(
    body.policy,
    network,
    treasury.community_id,
    treasuryId,
  );

  const { paymentScript, scriptCbor: spendScriptCbor } = resolveTreasury(
    treasury,
    signers,
  );
  const forgeScript = mintPolicyScript(paymentScript, lockSlot);
  const policyId = resolveNativeScriptHash(forgeScript);
  const { scriptCbor: forgeScriptCbor } = serializeNativeScript(
    forgeScript,
    undefined,
    network,
    true,
  );
  if (!forgeScriptCbor) {
    throw new InvariantError("Failed to serialize forge script");
  }

  // ---- assets
  let ticker: string | undefined;
  let decimals = 0;
  if (assetKind === "ft") {
    const t = validateTicker(body.ticker ?? "");
    if (!t.ok) throw new BadRequestError(t.error);
    ticker = t.ticker;
    decimals = body.decimals ?? 0;
  }
  const url = (body.url ?? "").trim() || undefined;
  if (url && !HTTP_URL_RE.test(url)) {
    throw new BadRequestError("Invalid website URL");
  }

  const cip25Assets: Cip25Asset[] = [];
  const specs: MintAssetSpec[] = [];
  const mintRows: {
    asset_name: string;
    asset_name_hex: string;
    quantity: string;
    image_cid: string;
  }[] = [];
  for (const input of assetInputs) {
    const nameCheck = validateAssetName(input.name ?? "");
    if (!nameCheck.ok) throw new BadRequestError(nameCheck.error);
    const cid = (input.imageCid ?? "").trim();
    if (!CID_RE.test(cid)) {
      throw new BadRequestError(`${nameCheck.name}: image CID is invalid`);
    }
    const mediaType = (input.mediaType ?? "").trim();
    if (mediaType && !IMAGE_MIME_RE.test(mediaType)) {
      throw new BadRequestError(`${nameCheck.name}: unsupported media type`);
    }
    let quantity: bigint;
    if (assetKind === "ft") {
      try {
        quantity = scaleDecimal(String(body.supply ?? ""), decimals);
      } catch (err) {
        throw new BadRequestError(errorMessage(err, "Invalid supply"));
      }
      if (quantity <= 0n) {
        throw new BadRequestError("Supply must be greater than zero");
      }
    } else {
      quantity = 1n;
    }
    if (specs.some((s) => s.assetNameHex === nameCheck.hex)) {
      throw new BadRequestError(`Duplicate asset name: ${nameCheck.name}`);
    }
    cip25Assets.push({
      assetName: nameCheck.name,
      image: `ipfs://${cid}`,
      mediaType: mediaType || undefined,
      description: input.description,
      ticker,
      decimals: assetKind === "ft" ? decimals : undefined,
      url,
      attributes: assetKind === "nft" ? (input.attributes ?? {}) : undefined,
    });
    specs.push({ assetNameHex: nameCheck.hex, quantity });
    mintRows.push({
      asset_name: nameCheck.name,
      asset_name_hex: nameCheck.hex,
      quantity: quantity.toString(),
      image_cid: cid,
    });
  }

  const metadata721 = buildCip25Metadata(policyId, cip25Assets);
  const dateStr = new Date().toISOString().slice(0, 10);
  const description =
    assetKind === "ft"
      ? `Mint: ${formatQuantity(specs[0]?.quantity ?? 0n, decimals)} ${ticker}`
      : `Mint: ${plural(specs.length, "NFT")} (${mintRows
          .map((r) => r.asset_name)
          .join(", ")
          .slice(0, 80)})`;

  const built = await buildMintTx({
    treasuryAddress: treasury.address,
    spendScriptCbor,
    forgeScriptCbor,
    policyId,
    network,
    provider: getProvider(network),
    assets: specs,
    recipient,
    metadata721,
    message: `Guild Vault mint: ${ctx.communitySlug} ${dateStr}, ${description.slice(6)}`,
    lockSlot,
    validFromSlot: validFromSlotFor(treasury, path),
  });

  const entries = metadata721[policyId] ?? {};
  const txRow = await withTransactionRow(
    {
      treasury_id: treasuryId,
      kind: TxKind.Mint,
      spending_path: path,
      tx_cbor: built.unsignedTxHex,
      tx_hash: built.txHash,
      description,
      created_by: wallet,
    },
    async (tx) => {
      await insertMints(
        mintRows.map((r) => ({
          transaction_id: tx.id,
          community_id: treasury.community_id,
          treasury_id: treasuryId,
          asset_kind: assetKind,
          policy_id: policyId,
          policy_script: forgeScript,
          policy_script_cbor: forgeScriptCbor,
          lock_slot: lockSlot,
          lock_until: lockUntil,
          asset_name: r.asset_name,
          asset_name_hex: r.asset_name_hex,
          quantity: r.quantity,
          decimals,
          ticker: ticker ?? null,
          image_cid: r.image_cid,
          recipient,
          metadata: entries[r.asset_name] ?? {},
          created_by: wallet,
        })),
      );
      return tx;
    },
  );

  return {
    txId: txRow.id,
    txHash: built.txHash,
    policyId,
    lockSlot,
    lockUntil,
    units: specs.map((s) => joinUnit(policyId, s.assetNameHex)),
  } satisfies BuildMintResponse;
});
