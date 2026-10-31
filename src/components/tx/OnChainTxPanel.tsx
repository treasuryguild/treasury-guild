"use client";

import { useMemo } from "react";
import Link from "next/link";
import { unitDisplayFromRegistry } from "@/lib/assetRegistry";
import type { AssetDef } from "@/lib/assets";
import type { DecodedTxView } from "@/lib/cardano/types";
import { asNetwork } from "@/lib/config";
import { TxKind, TxState } from "@/lib/constants";
import type { ExternalTxRow, GovernanceAction, TreasuryRow } from "@/lib/db/types";
import {
  isRecognizedExternalActivity,
  type ExternalActivity,
} from "@/lib/externalActivity";
import { formatDate } from "@/lib/format";
import { routes } from "@/lib/routes";
import {
  CopyButton,
  ErrorText,
  ExplorerLink,
  PageTitle,
  TxKindBadge,
  TxStateBadge,
} from "@/components/ui";
import { AnchorRecordCard } from "./AnchorRecordCard";
import { GovernanceActionCard } from "./GovernanceActionCard";
import { OutputsCard } from "./OutputsCard";
import { RegistrationRecordCard } from "./RegistrationRecordCard";

export interface OnChainTxPanelProps {
  slug: string;
  row: ExternalTxRow;
  treasury: Pick<TreasuryRow, "id" | "name" | "address" | "network">;
  activity: ExternalActivity | null;
  title: string;
  governanceAction: GovernanceAction | null;
  decoded: DecodedTxView;
  cborTrusted: boolean;
  assetRegistry: AssetDef[];
  citedProposals: Record<number, string>;
}

/** Read-only details for an `external_txs` spend (no signing chrome). */
export function OnChainTxPanel({
  slug,
  row,
  treasury,
  activity,
  title,
  governanceAction,
  decoded,
  cborTrusted,
  assetRegistry,
  citedProposals,
}: OnChainTxPanelProps) {
  const display = useMemo(() => unitDisplayFromRegistry(assetRegistry), [assetRegistry]);
  const mintByUnit = useMemo(
    () => new Map(decoded.mint.map((m) => [m.unit, m])),
    [decoded.mint],
  );
  const network = asNetwork(treasury.network);
  const recognized = isRecognizedExternalActivity(activity);
  const isRegistration = activity?.kind === TxKind.Registration || !!decoded.registrationMeta;
  const isAnchor = activity?.kind === TxKind.Anchor || !!decoded.anchorMeta;

  return (
    <div className="mx-auto max-w-3xl">
      <PageTitle
        action={
          <span className="flex items-center gap-2">
            {recognized && <TxKindBadge kind={activity.kind} />}
            <TxStateBadge state={TxState.Confirmed} />
          </span>
        }
      >
        {title}
      </PageTitle>

      <p className="-mt-3 mb-4 text-sm text-zinc-400">
        {treasury.name} · {formatDate(row.block_time, "datetime")} · on-chain
        {recognized ? "" : " · not built in this app"}
      </p>

      <p className="mb-4 flex flex-wrap items-center gap-x-3 gap-y-1 text-sm text-zinc-400">
        <span className="inline-flex min-w-0 items-center gap-1.5 font-mono text-xs text-zinc-300">
          <span className="break-all">{row.tx_hash}</span>
          <CopyButton value={row.tx_hash} label="Copy transaction hash" />
        </span>
        <ExplorerLink
          network={network}
          target={{ txHash: row.tx_hash }}
          className="underline-offset-2 hover:underline"
        >
          Open in explorer
        </ExplorerLink>
        <Link
          href={routes.treasury(slug)}
          className="underline-offset-2 hover:underline"
        >
          Back to Treasury
        </Link>
      </p>

      {!cborTrusted && (
        <ErrorText
          error="Could not load on-chain transaction bytes. Summary below is from what Treasury Guild recorded; open the explorer for the full transaction."
          className="mb-4"
        />
      )}

      {isRegistration && (
        <p className="mb-4 text-sm text-zinc-400">
          This transaction moves no funds: it carries a CIP-0146 registration record and returns
          the change to the treasury, minus the fee.
        </p>
      )}

      {isAnchor && !isRegistration && (
        <p className="mb-4 text-sm text-zinc-400">
          This transaction moves no funds: it carries an on-chain anchor record and returns the
          change to the treasury, minus the fee.
        </p>
      )}

      <AnchorRecordCard
        slug={slug}
        anchorMeta={decoded.anchorMeta}
        citedProposals={citedProposals}
      />

      <RegistrationRecordCard registrationMeta={decoded.registrationMeta} />

      {cborTrusted && (
        <OutputsCard
          slug={slug}
          outputs={decoded.outputs}
          fee={decoded.fee}
          message={decoded.message}
          payoutMeta={decoded.payoutMeta}
          localTaskNumbers={{}}
          citedProposals={citedProposals}
          treasuryAddress={treasury.address}
          isMintTx={decoded.mint.length > 0}
          mintByUnit={mintByUnit}
          display={display}
          cip25Meta={decoded.cip25Meta}
          transferAddresses={new Set()}
        />
      )}

      {!cborTrusted && (
        <dl className="mb-4 space-y-2 rounded-lg border border-zinc-800 px-4 py-3 text-sm">
          <div className="flex justify-between gap-3">
            <dt className="text-zinc-500">Fee (recorded)</dt>
            <dd className="font-mono text-xs text-zinc-200">{row.fee_lovelace} lovelace</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-zinc-500">Paid out (excl. change)</dt>
            <dd className="font-mono text-xs text-zinc-200">{row.amount_lovelace} lovelace</dd>
          </div>
          <div className="flex justify-between gap-3">
            <dt className="text-zinc-500">Recipients</dt>
            <dd className="font-mono text-xs text-zinc-200">{row.to_addresses.length}</dd>
          </div>
        </dl>
      )}

      <GovernanceActionCard action={governanceAction} />
    </div>
  );
}
