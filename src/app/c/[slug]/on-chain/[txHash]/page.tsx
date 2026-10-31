import { getSession } from "@/lib/auth/session";
import { loadOnChainTxPageData } from "@/lib/db/onChainTxPage";
import { PageMessage } from "@/components/ui";
import { OnChainTxPanel } from "@/components/tx/OnChainTxPanel";

export default async function OnChainTxPage({
  params,
}: {
  params: Promise<{ slug: string; txHash: string }>;
}) {
  const { slug, txHash } = await params;
  const session = await getSession();
  const data = await loadOnChainTxPageData(slug, txHash, session?.wallet ?? null);
  if (!data) {
    return (
      <PageMessage>
        On-chain transaction not found (are you signed in as a community member?).
      </PageMessage>
    );
  }

  return (
    <OnChainTxPanel
      slug={data.slug}
      row={data.row}
      treasury={data.treasury}
      activity={data.activity}
      title={data.title}
      governanceAction={data.governanceAction}
      decoded={data.decoded}
      cborTrusted={data.cborTrusted}
      assetRegistry={data.assetRegistry}
      citedProposals={data.citedProposals}
    />
  );
}
