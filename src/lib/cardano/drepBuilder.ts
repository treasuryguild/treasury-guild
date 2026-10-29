// Builds DRep registration / update / retirement for an SDK treasury.
// When role-3 is incomplete, the payment script is the DRep (Multisig fallback);
// certificateScript is omitted when DRep CBOR equals the payment script.
import "server-only";

import { hashDrepAnchor, type IFetcher } from "@meshsdk/common";

import { DrepAction } from "@/lib/constants";
import type { Network } from "@/lib/config";
import { pinataGateway } from "@/lib/env.server";
import { ipfsStore } from "@/lib/storage/ipfs";
import { completeCertTx } from "./certTxBuilder";

const DREP_DEPOSIT = 500_000_000n;

export interface DrepAnchorInput {
  /** Full CIP-119 JSON document. */
  anchorJson?: Record<string, unknown>;
  givenName?: string;
  motivations?: string;
  objectives?: string;
  qualifications?: string;
  imageUrl?: string;
}

export function buildDrepAnchorJson(input: DrepAnchorInput): Record<string, unknown> {
  if (input.anchorJson) return input.anchorJson;
  const givenName = input.givenName?.trim();
  if (!givenName) throw new Error("DRep given name is required");
  return {
    "@context": {
      CIP100: "https://github.com/cardano-foundation/CIPs/blob/master/CIP-0100/README.md#",
      CIP119: "https://github.com/cardano-foundation/CIPs/blob/master/CIP-0119/README.md#",
      hashAlgorithm: "CIP100:hashAlgorithm",
      body: {
        "@id": "CIP119:body",
        "@context": {
          references: {
            "@id": "CIP119:references",
            "@container": "@set",
            "@context": {
              GovernanceMetadata: "CIP100:GovernanceMetadataReference",
              Other: "CIP100:OtherReference",
              label: "CIP100:reference-label",
              uri: "CIP100:reference-uri",
              referenceHash: {
                "@id": "CIP100:referenceHash",
                "@context": {
                  hashDigest: "CIP100:hashDigest",
                  hashAlgorithm: "CIP100:hashAlgorithm",
                },
              },
            },
          },
          paymentAddress: "CIP119:paymentAddress",
          givenName: "CIP119:givenName",
          image: {
            "@id": "CIP119:image",
            "@context": { ImageObject: "https://schema.org/ImageObject" },
          },
          objectives: "CIP119:objectives",
          motivations: "CIP119:motivations",
          qualifications: "CIP119:qualifications",
          doNotList: "CIP119:doNotList",
        },
      },
      authors: {
        "@id": "CIP100:authors",
        "@container": "@set",
        "@context": {
          name: "http://xmlns.com/foaf/0.1/name",
          witness: {
            "@id": "CIP100:witness",
            "@context": {
              witnessAlgorithm: "CIP100:witnessAlgorithm",
              publicKey: "CIP100:publicKey",
              signature: "CIP100:signature",
            },
          },
        },
      },
    },
    hashAlgorithm: "blake2b-256",
    body: {
      givenName,
      ...(input.objectives?.trim() ? { objectives: input.objectives.trim() } : {}),
      ...(input.motivations?.trim() ? { motivations: input.motivations.trim() } : {}),
      ...(input.qualifications?.trim() ? { qualifications: input.qualifications.trim() } : {}),
      ...(input.imageUrl?.trim()
        ? { image: { "@type": "ImageObject", contentUrl: input.imageUrl.trim() } }
        : {}),
    },
  };
}

/** Pin CIP-119 JSON and return the gateway URL + Mesh anchor hash. */
export async function pinDrepAnchor(
  doc: Record<string, unknown>,
): Promise<{ anchorUrl: string; anchorDataHash: string }> {
  // Mesh hashes the exact JSON string; pin the same bytes.
  const body = JSON.stringify(doc);
  const cid = await ipfsStore().put(new TextEncoder().encode(body), "drep-metadata.json", {
    kind: "drep-anchor",
  });
  const anchorUrl = `https://${pinataGateway()}/ipfs/${cid}`;
  const anchorDataHash = hashDrepAnchor(JSON.parse(body) as Record<string, unknown>);
  return { anchorUrl, anchorDataHash };
}

export async function buildDrepTx(opts: {
  treasuryAddress: string;
  paymentScriptCbor: string;
  drepScriptCbor: string;
  dRepId: string;
  network: Network;
  provider: IFetcher;
  action: DrepAction;
  anchor?: { anchorUrl: string; anchorDataHash: string } | null;
}): Promise<{ unsignedTxHex: string; txHash: string }> {
  const { action, dRepId, drepScriptCbor, paymentScriptCbor, anchor } = opts;
  if ((action === DrepAction.Register || action === DrepAction.Update) && !anchor) {
    throw new Error(`anchor is required for DRep ${action}`);
  }

  return completeCertTx({
    treasuryAddress: opts.treasuryAddress,
    paymentScriptCbor,
    network: opts.network,
    provider: opts.provider,
    depositLovelace: action === DrepAction.Register ? DREP_DEPOSIT : 0n,
    apply: (txBuilder) => {
      if (action === DrepAction.Register) {
        txBuilder.drepRegistrationCertificate(dRepId, anchor!);
      } else if (action === DrepAction.Update) {
        txBuilder.drepUpdateCertificate(dRepId, anchor!);
      } else {
        txBuilder.drepDeregistrationCertificate(dRepId);
      }
      if (drepScriptCbor !== paymentScriptCbor) {
        txBuilder.certificateScript(drepScriptCbor);
      }
    },
  });
}
