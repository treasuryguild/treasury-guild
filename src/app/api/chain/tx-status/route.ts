import { parseQuery, sessionRoute } from "@/lib/api/route";
import { txStatusQuerySchema } from "@/lib/api/schemas";
import type { TxStatusResponse } from "@/lib/api/types";
import { txInfoBulk } from "@/lib/cardano/koios";
import { enforceRateLimit } from "@/lib/db/rateLimit";

export const GET = sessionRoute(async (req, { session }) => {
  const { hash, network } = parseQuery(req, txStatusQuerySchema);
  await enforceRateLimit("chainProxy", session.wallet);
  const [row] = await txInfoBulk(network, [hash]);
  return {
    onChain: !!row,
    blockHeight: row?.block_height ?? null,
  } satisfies TxStatusResponse;
});
