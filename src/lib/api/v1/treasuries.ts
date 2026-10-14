// A community's treasuries: signing rule, signers, balance and the pending
// transaction, if any, waiting for signatures.
import "server-only";

import { z } from "zod";
import type { V1Treasury, V1TreasuryBalance, V1TreasuriesResponse } from "@/lib/api/types";
import { ADA_ASSET } from "@/lib/assets";
import { applyWalletTokenHint } from "@/lib/cardano/assetInfo";
import { defaultPath, pathRule } from "@/lib/cardano/spendingPaths";
import { requiredSignatures } from "@/lib/cardano/thresholds";
import { asNetwork, networkName } from "@/lib/config";
import { loadMintAssetHints } from "@/lib/db/assets";
import { enforceRateLimit } from "@/lib/db/rateLimit";
import { loadPendingTransactions, type PendingTransaction } from "@/lib/db/transactions";
import { listCommunityTreasuries, type TreasuryWithSigners } from "@/lib/db/treasuries";
import { isProduction } from "@/lib/env.server";
import { errorMessage, UpstreamError } from "@/lib/errors";
import { routes } from "@/lib/routes";
import { defineEndpoint } from "./endpoint";
import { displayQuantity, signingRule } from "./shape";
import { appLink, communityInput, memberCommunity } from "./shared";

const CHAIN_UNREADABLE = "The chain could not be read";

async function readBalance(treasury: TreasuryWithSigners): Promise<V1TreasuryBalance> {
  // Lazy: the chain reader pulls Mesh (WASM), which a bare tools/list or a
  // balance-less call should not load.
  const { fetchWalletAssets } = await import("@/lib/cardano/walletAssets");
  const { lovelace, utxoCount, tokens } = await fetchWalletAssets(asNetwork(treasury.network), treasury.address);
  const unresolved = tokens.filter((t) => t.source === "ascii" || t.source === "none").map((t) => t.unit);
  const hints = await loadMintAssetHints(unresolved);
  return {
    ada: displayQuantity(lovelace, ADA_ASSET.decimals),
    lovelace: lovelace.toString(),
    utxoCount,
    tokens: tokens.map((token) => {
      const t = applyWalletTokenHint(token, hints.get(token.unit));
      return { unit: t.unit, ticker: t.ticker, name: t.name, quantity: displayQuantity(t.quantity, t.decimals), decimals: t.decimals };
    }),
  };
}

function describePending(
  slug: string,
  tx: PendingTransaction | undefined,
  treasury: TreasuryWithSigners,
): V1Treasury["pendingTransaction"] {
  if (!tx) return null;
  return {
    id: tx.id,
    kind: tx.kind,
    description: tx.description,
    spendingPath: tx.spending_path,
    signatures: tx.signed_addresses.length,
    requiredSignatures: requiredSignatures(pathRule(treasury, treasury.treasury_signers, tx.spending_path)),
    rejections: tx.rejected_addresses.length,
    createdAt: tx.created_at,
    url: appLink(routes.tx(slug, tx.id)),
  };
}

export const treasuryOverview = defineEndpoint({
  scope: "communities:read",
  input: z.object({
    community: communityInput,
    balances: z.boolean().default(true).describe("Read each treasury's current balance from the chain"),
  }),
  async run(caller, { community: slug, balances }): Promise<V1TreasuriesResponse> {
    const { community } = await memberCommunity(caller, slug);
    const treasuries = await listCommunityTreasuries(community.id);
    const pending = new Map(
      (await loadPendingTransactions(treasuries.map((t) => t.id))).map((tx) => [tx.treasury_id, tx]),
    );
    if (balances && treasuries.length > 0) await enforceRateLimit("chainProxy", caller.wallet);

    const described = await Promise.all(
      treasuries.map(async (treasury): Promise<V1Treasury> => {
        const needed = requiredSignatures(pathRule(treasury, treasury.treasury_signers, defaultPath(treasury.template)));
        let balance: V1TreasuryBalance | null = null;
        let balanceError: string | null = null;
        if (balances) {
          try {
            balance = await readBalance(treasury);
          } catch (err) {
            console.error(`agent API: balance of treasury ${treasury.id} failed`, err);
            // Provider or library internals stay out of production answers.
            balanceError = err instanceof UpstreamError || !isProduction()
              ? errorMessage(err, CHAIN_UNREADABLE)
              : CHAIN_UNREADABLE;
          }
        }
        return {
          id: treasury.id,
          name: treasury.name,
          address: treasury.address,
          network: networkName(asNetwork(treasury.network)),
          template: treasury.template,
          lockUntil: treasury.lock_until,
          signingRule: signingRule(treasury, treasury.treasury_signers),
          requiredSignatures: needed,
          signers: treasury.treasury_signers.map((s) => ({ name: s.display_name, address: s.wallet_address, group: s.signer_group })),
          balance,
          balanceError,
          pendingTransaction: describePending(community.slug, pending.get(treasury.id), treasury),
        };
      }),
    );

    return {
      community: { slug: community.slug, name: community.name, network: networkName(asNetwork(community.network)) },
      treasuries: described,
      url: appLink(routes.treasury(community.slug)),
    };
  },
});
