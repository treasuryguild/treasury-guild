// Resolve the native script of a CIP-0146 registration transaction into an
// importable Treasury Guild treasury (one of the four template shapes).
import { parseQuery, sessionRoute } from "@/lib/api/route";
import { cip146ResolveQuerySchema } from "@/lib/api/schemas";
import type { Cip146ResolveResponse } from "@/lib/api/types";
import { resolveRegistrationImport } from "@/lib/cardano/cip146Lookup";
import { asNetwork } from "@/lib/config";
import { enforceRateLimit } from "@/lib/db/rateLimit";

export const GET = sessionRoute(async (req, { session }) => {
  const { network, txHash } = parseQuery(req, cip146ResolveQuerySchema);
  await enforceRateLimit("chainProxy", session.wallet);
  const discovered = await resolveRegistrationImport(asNetwork(network), txHash);
  return {
    txHash: discovered.txHash,
    address: discovered.address,
    scriptCbor: discovered.scriptCbor,
    stakeCredentialHash: discovered.stakeCredentialHash,
    name: discovered.name,
    description: discovered.description,
    participants: discovered.participants,
    template: discovered.decoded.shape.template,
    scriptType: discovered.decoded.scriptType,
    required: discovered.decoded.required,
  } satisfies Cip146ResolveResponse;
});
