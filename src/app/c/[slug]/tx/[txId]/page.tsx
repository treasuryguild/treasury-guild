import { getSession } from "@/lib/auth/session";
import { decodeTxForDisplay } from "@/lib/cardano/cborMetadata";
import { loadTxPageData } from "@/lib/db/txPage";
import { pinataGateway } from "@/lib/env.server";
import { PageMessage } from "@/components/ui";
import { TxSigningPanel } from "@/components/tx/TxSigningPanel";

export default async function TxPage({
  params,
}: {
  params: Promise<{ slug: string; txId: string }>;
}) {
  const { slug, txId } = await params;
  const session = await getSession();
  const data = await loadTxPageData(txId, session?.wallet ?? null);
  if (!data) {
    return (
      <PageMessage>
        Transaction not found (are you signed in as a community member?).
      </PageMessage>
    );
  }

  return (
    <TxSigningPanel
      slug={slug}
      tx={data.tx}
      treasury={data.treasury}
      signers={data.signers}
      // Decoded from the CBOR — the only faithful source for outputs & metadata.
      decoded={decodeTxForDisplay(data.tx.txCbor)}
      assetRegistry={data.assetRegistry}
      ipfsGateway={pinataGateway()}
      payments={data.payments}
      localTaskNumbers={data.localTaskNumbers}
      citedProposals={data.citedProposals}
      cosignerDecisions={data.cosignerDecisions}
      isAdmin={data.isAdmin}
    />
  );
}
