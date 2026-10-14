// A transaction's label-190002 anchor record, read from the chain: Koios
// serves the CBOR (server-side only), the hash is checked with core-cst and
// the record is decoded from the CBOR itself. The proposal page's Verify
// button compares it with the frozen tally document in the browser.
import { resolveTxHash } from "@meshsdk/core-cst";
import { parseQuery, sessionRoute } from "@/lib/api/route";
import { txStatusQuerySchema } from "@/lib/api/schemas";
import type { TxMetadataResponse } from "@/lib/api/types";
import { extractAnchorMetadata } from "@/lib/cardano/cborMetadata";
import { txCborBulk, txInfoBulk } from "@/lib/cardano/koios";
import { enforceRateLimit } from "@/lib/db/rateLimit";

export const GET = sessionRoute(async (req, { session }) => {
  const { hash, network } = parseQuery(req, txStatusQuerySchema);
  await enforceRateLimit("chainProxy", session.wallet);
  const [[info], cbors] = await Promise.all([txInfoBulk(network, [hash]), txCborBulk(network, [hash])]);
  const cbor = cbors.get(hash);
  const trusted = cbor !== undefined && resolveTxHash(cbor) === hash;
  return {
    onChain: !!info,
    blockTime: info ? new Date(info.tx_timestamp * 1000).toISOString() : null,
    anchor: trusted ? (extractAnchorMetadata(cbor) ?? null) : null,
  } satisfies TxMetadataResponse;
});
