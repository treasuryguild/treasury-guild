"use client";

import { CIP25_METADATA_LEGEND } from "@/lib/cardano/metadataLegend";
import { describeMint } from "@/lib/cardano/txDisplay";
import type { DecodedTxMint } from "@/lib/cardano/types";
import { plural, shortAddress } from "@/lib/format";
import { Card, CopyButton, JsonDetails } from "@/components/ui";

export function MintPreview({
  mint,
  cip25Meta,
  ttl,
  isMintTx,
  ipfsGateway,
}: {
  mint: DecodedTxMint[];
  cip25Meta: unknown;
  ttl: string | null;
  isMintTx: boolean;
  ipfsGateway: string;
}) {
  if (mint.length === 0) return null;
  return (
    <Card className="mb-4">
      <h3 className="mb-3 text-sm font-medium text-zinc-400">
        Minting ({plural(mint.length, "asset")})
      </h3>
      <div className="space-y-3">
        {mint.map((m) => {
          const d = describeMint(m, cip25Meta, ipfsGateway);
          return (
            <div
              key={m.unit}
              className="flex flex-col gap-4 rounded-xl bg-zinc-800/60 p-3 sm:flex-row"
            >
              {d.imageUrl ? (
                // eslint-disable-next-line @next/next/no-img-element
                <img
                  src={d.imageUrl}
                  alt={d.name}
                  className="h-20 w-20 shrink-0 rounded-lg bg-zinc-900 object-cover"
                />
              ) : (
                <div className="flex h-20 w-20 shrink-0 items-center justify-center rounded-lg bg-zinc-900 text-2xl">
                  🪙
                </div>
              )}
              <div className="min-w-0 flex-1">
                <div className="flex items-start justify-between gap-3">
                  <p className="font-medium">{d.name}</p>
                  <p className="shrink-0 text-sm font-medium">
                    {d.burn ? "Burn " : "+"}
                    {d.amount}
                  </p>
                </div>
                {d.description && (
                  <p className="mt-1 text-xs text-zinc-400">{d.description}</p>
                )}
                <p className="mt-1 flex items-center gap-1.5 font-mono text-[11px] text-zinc-500">
                  policy {shortAddress(m.policyId)}
                  <CopyButton value={m.policyId} label="Copy policy id" />
                </p>
                {d.imageUri && (
                  <p className="truncate font-mono text-[11px] text-zinc-500">
                    {d.imageUri}
                  </p>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {ttl && (
        <p className="mt-3 text-xs text-zinc-500">
          Valid until slot {ttl}
          {isMintTx ? " (policy time lock)" : ""}
        </p>
      )}
      <JsonDetails label="On-chain CIP-25 metadata (label 721)" value={cip25Meta} legend={CIP25_METADATA_LEGEND} />
    </Card>
  );
}
