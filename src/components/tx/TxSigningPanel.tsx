"use client";

import { useMemo } from "react";
import { useRouter } from "next/navigation";
import { unitDisplayFromRegistry } from "@/lib/assetRegistry";
import { pathLabel, pathParticipants, pathRule } from "@/lib/cardano/spendingPaths";
import { describeRule, thresholdReached } from "@/lib/cardano/thresholds";
import { asNetwork } from "@/lib/config";
import { MSG, SpendingPath, TxKind, TxState } from "@/lib/constants";
import { formatDate } from "@/lib/format";
import { useSession } from "@/hooks/useSession";
import { useTxActions } from "@/hooks/useTxActions";
import { useNetworkGate } from "@/hooks/useNetworkGate";
import { useTxStatusPoll } from "@/hooks/useTxStatusPoll";
import {
  BusyOverlay,
  CopyButton,
  ErrorText,
  ExplorerLink,
  PageTitle,
  TxKindBadge,
  TxStateBadge,
} from "@/components/ui";
import { AnchorRecordCard } from "./AnchorRecordCard";
import { CosignerCard } from "./CosignerCard";
import { MintPreview } from "./MintPreview";
import { OutputsCard } from "./OutputsCard";
import { PaymentPreview } from "./PaymentPreview";
import { SignaturesCard } from "./SignaturesCard";
import { SpendProblemsCard } from "./SpendProblemsCard";
import { TxActionBar } from "./TxActionBar";
import type { TxPanelProps } from "./types";

export function TxSigningPanel({
  slug,
  tx,
  treasury,
  signers,
  decoded,
  assetRegistry,
  ipfsGateway,
  payments,
  localTaskNumbers,
  citedProposals,
  cosignerDecisions,
  isAdmin,
}: TxPanelProps) {
  const router = useRouter();
  const { wallet, sessionWallet, connected, connecting, walletMismatch } = useSession();
  const actions = useTxActions(tx.id, slug);
  const chainStatus = useTxStatusPoll(
    tx.txHash,
    asNetwork(treasury.network),
    tx.state === TxState.Submitted,
  );
  const { reason: networkReason } = useNetworkGate(treasury.network);
  // Signing needs the CIP-30 wallet, which the session cookie alone does not
  // give us: after a reload the persisted connection is restored async, and
  // it may not come back at all (declined, locked). It also has to be the
  // account the session belongs to, or the server rejects the witness. Say
  // so on the button instead of failing on click.
  const walletReason = !wallet
    ? connecting || connected
      ? "Connecting your wallet…"
      : MSG.walletNotConnected
    : walletMismatch
      ? MSG.walletSwitched
      : null;
  const blockedReason = walletReason ?? networkReason;

  const display = useMemo(() => unitDisplayFromRegistry(assetRegistry), [assetRegistry]);
  const mintByUnit = useMemo(
    () => new Map(decoded.mint.map((m) => [m.unit, m])),
    [decoded.mint],
  );

  const isMintTx = tx.kind === TxKind.Mint;
  const isPaymentTx = tx.kind === TxKind.Payment;
  const isAnchorTx = tx.kind === TxKind.Anchor;
  const isCosigned = tx.spendingPath === SpendingPath.Cosigned;
  const transferAddresses = useMemo(
    () => new Set(payments.filter((p) => p.recipient_treasury_id).map((p) => p.recipient_wallet)),
    [payments],
  );
  // Whose signatures count: the rule of the transaction's own spending path.
  const rule = useMemo(() => pathRule(treasury, signers, tx.spendingPath), [treasury, signers, tx.spendingPath]);
  const isParticipant = !!sessionWallet && pathParticipants(rule).includes(sessionWallet);
  const isBaseSigner = !!sessionWallet && signers.some((s) => s.wallet_address === sessionWallet && s.signer_group === "base");
  const hasResponded =
    !!sessionWallet &&
    (tx.signedAddresses.includes(sessionWallet) ||
      tx.rejectedAddresses.includes(sessionWallet));
  const meetsThreshold = (signed: string[]) => thresholdReached(rule, signed);
  const thresholdMet = meetsThreshold(tx.signedAddresses);
  const pathNote = tx.spendingPath === SpendingPath.Base && treasury.template === "plain"
    ? null
    : `${pathLabel(tx.spendingPath)} · ${describeRule(rule)}${
        treasury.lock_until && (tx.spendingPath === SpendingPath.Recovery || treasury.template === "lock_until")
          ? ` · valid from ${formatDate(treasury.lock_until, "datetime")}`
          : ""
      }`;

  const overlay =
    actions.busy === "sign"
      ? { title: "Check your wallet to sign", hint: "Approve the signature in your wallet. Keep this tab open." }
      : actions.busy === "submit"
        ? { title: "Submitting to chain…", hint: "Broadcasting the signed transaction. Keep this tab open." }
        : actions.refreshing
          ? { title: "Updating…", hint: null }
          : null;

  return (
    <div className="mx-auto max-w-3xl">
      <BusyOverlay open={overlay !== null} title={overlay?.title ?? ""} hint={overlay?.hint} />
      <PageTitle
        action={
          <span className="flex items-center gap-2">
            <TxKindBadge kind={tx.kind} />
            <TxStateBadge state={tx.state} />
          </span>
        }
      >
        {tx.description ?? "Transaction"}
      </PageTitle>
      {pathNote && <p className="-mt-3 mb-4 text-sm text-zinc-400">{pathNote}</p>}

      <MintPreview
        mint={decoded.mint}
        cip25Meta={decoded.cip25Meta}
        ttl={decoded.ttl}
        isMintTx={isMintTx}
        ipfsGateway={ipfsGateway}
      />

      {isPaymentTx && (
        <PaymentPreview
          slug={slug}
          payoutMeta={decoded.payoutMeta}
          outputs={decoded.outputs}
          payments={payments}
          citedProposals={citedProposals}
        />
      )}

      {isAnchorTx && (
        <p className="mb-4 text-sm text-zinc-400">
          This transaction moves no funds: it carries only the anchor record below and returns the change to
          the treasury, minus the fee.
        </p>
      )}

      <AnchorRecordCard slug={slug} anchorMeta={decoded.anchorMeta} citedProposals={citedProposals} />

      <OutputsCard
        slug={slug}
        outputs={decoded.outputs}
        fee={decoded.fee}
        message={decoded.message}
        payoutMeta={decoded.payoutMeta}
        localTaskNumbers={localTaskNumbers}
        citedProposals={citedProposals}
        treasuryAddress={treasury.address}
        isMintTx={isMintTx}
        mintByUnit={mintByUnit}
        display={display}
        cip25Meta={decoded.cip25Meta}
        transferAddresses={transferAddresses}
        metadataLabel={isPaymentTx ? "On-chain payment metadata (label 190001)" : undefined}
      />

      <SpendProblemsCard problems={tx.spendProblems} />

      {isCosigned && (
        <CosignerCard
          txId={tx.id}
          txState={tx.state}
          cosignerKind={treasury.cosigner_kind}
          initialDecisions={cosignerDecisions}
          canRerun={isAdmin || isBaseSigner}
          onChanged={() => router.refresh()}
        />
      )}

      <SignaturesCard
        signers={signers}
        signedAddresses={tx.signedAddresses}
        rejectedAddresses={tx.rejectedAddresses}
        rule={rule}
      />

      <ErrorText error={actions.error} className="mb-4" />

      {tx.state === TxState.Pending && isParticipant && (
        <TxActionBar
          canRespond={!hasResponded}
          thresholdMet={thresholdMet}
          busy={actions.busy}
          refreshing={actions.refreshing}
          isPayout={tx.kind === TxKind.Payout}
          blockedReason={blockedReason}
          // The final signature submits in the same step (server re-checks).
          onSign={() => void actions.sign(wallet, tx.txCbor, meetsThreshold)}
          onReject={() => void actions.reject()}
          onSubmit={() => void actions.submit()}
          onDelete={actions.remove}
        />
      )}

      {tx.txHash && (
        <p className="mt-4 flex items-center gap-1.5 font-mono text-xs text-zinc-500">
          Tx hash:{" "}
          <ExplorerLink network={asNetwork(treasury.network)} target={{ txHash: tx.txHash }}>
            {tx.txHash}
          </ExplorerLink>
          <CopyButton value={tx.txHash} label="Copy tx hash" />
          {chainStatus?.onChain && (
            <span className="text-emerald-400">
              · seen on-chain (block {chainStatus.blockHeight})
            </span>
          )}
        </p>
      )}
    </div>
  );
}
