// IPFS through Pinata, server-side: the first document store. The JWT is
// the one token images already use (PINATA_JWT); the locator is the bare
// CIDv1 (an "ipfs://" prefix would push it over the 64-byte metadatum cap
// when an anchor names it).
import "server-only";

import { PinataSDK } from "pinata";
import { pinataGateway, pinataJwt } from "@/lib/env.server";
import { copyUrl } from "./locator";
import type { DocumentStore } from "./types";

const RESOLVE_TIMEOUT_MS = 15_000;

export function ipfsStore(deps: {
  pinata?: () => Pick<PinataSDK, "upload">;
  gateway?: () => string;
  fetchImpl?: typeof fetch;
} = {}): DocumentStore {
  const gateway = deps.gateway ?? pinataGateway;
  const client = deps.pinata ?? (() => new PinataSDK({ pinataJwt: pinataJwt(), pinataGateway: gateway() }));
  const fetchImpl = deps.fetchImpl ?? fetch;
  return {
    name: "ipfs",
    async put(bytes, filename, tags) {
      const file = new File([bytes as BlobPart], filename, { type: "application/json" });
      const uploaded = await client().upload.public.file(file).name(filename).keyvalues({ app: "guild-vault", ...tags });
      return uploaded.cid;
    },
    url(locator) {
      return copyUrl("ipfs", locator, { ipfsGateway: gateway() });
    },
    async resolves(locator) {
      try {
        const res = await fetchImpl(copyUrl("ipfs", locator, { ipfsGateway: gateway() }), {
          method: "HEAD",
          signal: AbortSignal.timeout(RESOLVE_TIMEOUT_MS),
        });
        return res.ok;
      } catch {
        return false;
      }
    },
  };
}
