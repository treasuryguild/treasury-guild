"use client";

import { use } from "react";
import Link from "next/link";
import type { BuildMintResponse } from "@/lib/api/types";
import { downloadJson, fetchAsBase64 } from "@/lib/browser/download";
import type { MintWithTx } from "@/lib/db/types";
import { ipfsUrl } from "@/lib/ipfs";
import { cip26DraftForMint, cip26FileName } from "@/lib/mint/cip26";
import { routes } from "@/lib/routes";
import { useBuildTx } from "@/hooks/useBuildTx";
import { useNetworkGate } from "@/hooks/useNetworkGate";
import { useCommunityGate } from "@/hooks/useCommunityGate";
import { useIpfsGateway } from "@/hooks/useIpfsGateway";
import { useMints } from "@/hooks/useMints";
import { useMyTreasuryRoles } from "@/hooks/useMyTreasuryRoles";
import { activeTreasuries, useTreasuries } from "@/hooks/useTreasuries";
import { BusyOverlay, EmptyState, PageTitle, SectionTitle } from "@/components/ui";
import { MintForm } from "@/components/mint/MintForm";
import { MintedAssetsList } from "@/components/mint/MintedAssetsList";

export default function MintPage({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = use(params);
  const { community, isAdmin, blocked } = useCommunityGate(slug);
  const treasuries = useTreasuries(community?.id);
  const mints = useMints(community?.id);
  const roles = useMyTreasuryRoles(community?.id);
  const gateway = useIpfsGateway();
  const { build, busy, error } = useBuildTx(slug);
  const { reason: networkReason } = useNetworkGate(community?.network);

  if (blocked) return blocked;

  const allTreasuries = treasuries.data ?? [];
  const treasuryList = activeTreasuries(allTreasuries);
  const mintList = mints.data ?? [];
  const canMintAnywhere = roles.signerTreasuryIds.size > 0;
  const ready = !treasuries.loading && !roles.loading;

  async function downloadCip26(row: MintWithTx) {
    const logoBase64 =
      row.image_cid && gateway
        ? await fetchAsBase64(ipfsUrl(gateway, row.image_cid))
        : undefined;
    downloadJson(
      cip26FileName(row),
      cip26DraftForMint(row, `${community!.name} token`, logoBase64),
    );
  }

  return (
    <div className="mx-auto max-w-3xl">
      <PageTitle>Mint tokens</PageTitle>
      <BusyOverlay
        open={busy}
        title="Building mint transaction…"
        hint="Fetching treasury UTxOs and building the minting policy. Keep this tab open."
      />

      {!ready ? null : !canMintAnywhere ? (
        <EmptyState>Only treasury signers can mint tokens.</EmptyState>
      ) : treasuryList.length === 0 ? (
        <EmptyState>
          {allTreasuries.length > 0 ? (
            "Restore a treasury before minting from it."
          ) : (
            <>
              Create a multisig treasury first — its signers become the minting
              policy.{" "}
              {isAdmin && (
                <Link href={routes.newTreasury(slug)} className="text-indigo-400 hover:underline">
                  New treasury
                </Link>
              )}
            </>
          )}
        </EmptyState>
      ) : (
        <MintForm
          communityId={community!.id}
          treasuries={treasuryList}
          signerTreasuryIds={roles.signerTreasuryIds}
          mints={mintList}
          gateway={gateway}
          busy={busy}
          error={error}
          blockedReason={networkReason}
          onBuild={(body) => void build<BuildMintResponse>("/api/tx/build-mint", body)}
        />
      )}

      <SectionTitle className="mt-8">Minted assets</SectionTitle>
      <MintedAssetsList
        mints={mintList}
        slug={slug}
        gateway={gateway}
        loading={mints.loading}
        onDownloadCip26={(row) => void downloadCip26(row)}
      />
    </div>
  );
}
