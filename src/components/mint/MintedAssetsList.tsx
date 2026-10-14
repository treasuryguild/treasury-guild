"use client";

import Link from "next/link";
import { joinUnit } from "@/lib/cardano/units";
import type { MintWithTx } from "@/lib/db/types";
import { formatDate, formatUnits } from "@/lib/format";
import { ipfsUrl } from "@/lib/ipfs";
import { routes } from "@/lib/routes";
import {
  Badge,
  Card,
  CopyButton,
  EmptyState,
  TxStateBadge,
} from "@/components/ui";

export function MintedAssetsList({
  mints,
  slug,
  gateway,
  loading,
  onDownloadCip26,
}: {
  mints: MintWithTx[];
  slug: string;
  gateway: string | null;
  loading: boolean;
  onDownloadCip26: (row: MintWithTx) => void;
}) {
  return (
    <div className="space-y-3">
      {mints.map((m) => {
        const imageUrl = m.image_cid && gateway ? ipfsUrl(gateway, m.image_cid) : null;
        const unit = joinUnit(m.policy_id, m.asset_name_hex);
        return (
          <Card key={m.id} className="flex flex-wrap items-center gap-4 py-4 sm:flex-nowrap">
            {imageUrl ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img
                src={imageUrl}
                alt=""
                className="h-12 w-12 shrink-0 rounded-lg bg-zinc-900 object-cover"
              />
            ) : (
              <div className="flex h-12 w-12 shrink-0 items-center justify-center rounded-lg bg-zinc-900">
                🪙
              </div>
            )}
            <div className="min-w-0 flex-1">
              <p className="flex flex-wrap items-center gap-2 text-sm">
                <span className="font-medium">{m.asset_name}</span>
                <Badge>{m.asset_kind === "ft" ? "FT" : "NFT"}</Badge>
                <TxStateBadge state={m.transaction?.state ?? 0} />
              </p>
              <p className="mt-1 text-xs text-zinc-500">
                {formatUnits(m.quantity, m.decimals, m.ticker ?? undefined)} ·{" "}
                {formatDate(m.created_at)}
                {m.lock_until ? ` · policy locks ${formatDate(m.lock_until)}` : ""}
              </p>
              <p className="mt-1 flex items-center gap-1.5 font-mono text-[11px] text-zinc-500">
                {unit}
                <CopyButton value={unit} label="Copy unit" />
              </p>
            </div>
            <div className="ml-16 flex shrink-0 flex-col items-start gap-2 sm:ml-0 sm:items-end">
              <Link
                href={routes.tx(slug, m.transaction_id)}
                className="text-xs text-indigo-400 hover:underline"
              >
                Transaction
              </Link>
              {m.asset_kind === "ft" && (
                <button
                  type="button"
                  onClick={() => onDownloadCip26(m)}
                  className="text-xs text-zinc-400 hover:text-zinc-200"
                  title="Unsigned CIP-26 token registry mapping. Sign it with the policy keys (token-metadata-creator) before opening a registry PR."
                >
                  CIP-26 draft ↓
                </button>
              )}
            </div>
          </Card>
        );
      })}
      {!loading && mints.length === 0 && (
        <EmptyState card={false}>No tokens minted yet.</EmptyState>
      )}
    </div>
  );
}
