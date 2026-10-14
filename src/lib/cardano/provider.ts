// Mesh provider boundary. All blockchain access goes through IFetcher/ISubmitter
// so the provider can be swapped in one place. Server-side only (Koios has no
// CORS headers); the browser talks to /api/chain/* instead.
//
// Note: Mesh's KoiosProvider only takes a network keyword, so KOIOS_BASE_URL
// applies to the raw REST helpers in koios.ts, not to this provider.
import "server-only";

import { KoiosProvider } from "@meshsdk/provider";
import type { IFetcher, ISubmitter } from "@meshsdk/common";
import type { Network } from "@/lib/config";
import { koiosApiKey } from "@/lib/env.server";

const providers = new Map<Network, KoiosProvider>();

export function getProvider(network: Network): IFetcher & ISubmitter {
  let provider = providers.get(network);
  if (!provider) {
    provider = new KoiosProvider(
      network === 1 ? "api" : "preprod",
      koiosApiKey() ?? "",
    );
    providers.set(network, provider);
  }
  return provider;
}
