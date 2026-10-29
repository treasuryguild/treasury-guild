"use client";

// CIP-0146 on-chain registration card for the treasury details modal.
// Registration is a self-spend carrying label 1854 so co-signers can discover
// and import the wallet. Status comes from /api/chain/cip146/lookup; builds
// go through /api/tx/build-registration like other treasury transactions.
import { useMemo, useState } from "react";
import Link from "next/link";
import { apiFetch } from "@/lib/api/client";
import type {
  BuildRegistrationResponse,
  Cip146LookupResponse,
  TreasuryDetails,
} from "@/lib/api/types";
import {
  isRegistrationUpToDate,
  participantsMatchExactly,
  treasuryParticipantHashes,
  type Label1854LookupItem,
} from "@/lib/cardano/cip146Registration";
import { TxKind, TxState, type SpendingPath } from "@/lib/constants";
import {
  TRANSACTION_SUMMARY_COLUMNS,
  type TransactionSummary,
} from "@/lib/db/types";
import { actsForTreasury } from "@/lib/roles";
import { routes } from "@/lib/routes";
import { browserClient } from "@/lib/supabase/browser";
import { useAsyncData } from "@/hooks/useAsyncData";
import { useBuildTx } from "@/hooks/useBuildTx";
import { useMyTreasuryRoles } from "@/hooks/useMyTreasuryRoles";
import { offeredPaths, PathPicker } from "@/components/tx/PathPicker";
import { Button, ErrorText, ExplorerLink, Spinner } from "@/components/ui";

function toSignerRows(treasury: TreasuryDetails) {
  return treasury.signers.map((s) => ({
    key_hash: s.keyHash,
    stake_key_hash: s.stakeKeyHash,
    drep_key_hash: s.drepKeyHash,
    display_name: s.displayName,
    signer_group: s.group,
  }));
}

export function RegisterTreasury({
  treasury,
  slug,
  communityId,
}: {
  treasury: TreasuryDetails;
  slug: string;
  communityId: string;
}) {
  const roles = useMyTreasuryRoles(communityId);
  const canBuild = actsForTreasury(roles, treasury.id);
  const { build, busy, error } = useBuildTx(slug);
  const [path, setPath] = useState<SpendingPath | "">("");
  const [nowMs] = useState(() => Date.now());

  const keyHashes = useMemo(
    () => treasuryParticipantHashes(toSignerRows(treasury)),
    [treasury],
  );

  const lookup = useAsyncData(
    keyHashes.length > 0 ? `cip146:${treasury.network}:${keyHashes.join(",")}` : null,
    async () => {
      const hashes = keyHashes.slice(0, 50).join(",");
      return apiFetch<Cip146LookupResponse>("/api/chain/cip146/lookup", {
        query: { network: treasury.network, pubKeyHashes: hashes },
      });
    },
  );

  const pending = useAsyncData(`reg-pending:${treasury.id}`, async () => {
    const { data } = await browserClient()
      .from("transactions")
      .select(TRANSACTION_SUMMARY_COLUMNS)
      .eq("treasury_id", treasury.id)
      .eq("state", TxState.Pending)
      .eq("kind", TxKind.Registration)
      .limit(1);
    return ((data ?? []) as TransactionSummary[])[0] ?? null;
  });

  const matched = useMemo(() => {
    const items: Label1854LookupItem[] = (lookup.data?.registrations ?? []).map((r) => ({
      tx_hash: r.txHash,
      json_metadata: {
        types: r.types,
        name: r.name || undefined,
        description: r.description || undefined,
        participants: r.participants,
      },
    }));
    return items.filter((item) => participantsMatchExactly(item, keyHashes));
  }, [lookup.data, keyHashes]);

  const latest = matched[matched.length - 1] ?? null;
  const upToDate = latest
    ? isRegistrationUpToDate(latest, { name: treasury.name }, toSignerRows(treasury))
    : false;

  const pathTreasury = {
    template: treasury.template,
    script_type: treasury.scriptType,
    required: treasury.required,
    recovery_script_type: treasury.recovery?.scriptType ?? null,
    recovery_required: treasury.recovery?.required ?? null,
    lock_until: treasury.lockUntil,
    cosigner_kind: treasury.cosigner?.kind ?? null,
  };
  const offered = offeredPaths(pathTreasury, TxKind.Registration, nowMs);
  const chosenPath = path && offered.paths.includes(path) ? path : offered.paths[0];

  if (roles.loading) return null;
  if (!canBuild && matched.length === 0 && !lookup.loading) {
    // Viewers only see the card when something is already registered.
    return null;
  }

  return (
    <section className="rounded-xl border border-zinc-800 bg-zinc-900/40 p-4">
      <div className="mb-2 flex flex-wrap items-center gap-2">
        <h3 className="text-sm font-medium">Register wallet</h3>
        {latest && (
          <span className="rounded-full border border-emerald-500/30 bg-emerald-400/10 px-2 py-0.5 text-xs text-emerald-300">
            Registered
          </span>
        )}
      </div>
      <p className="mb-3 text-sm text-zinc-400">
        Register your wallet on-chain through a CIP-0146 registration transaction, so co-signers can discover and import it.
      </p>

      {lookup.loading || pending.loading ? (
        <p role="status" className="flex items-center gap-2 text-sm text-zinc-400">
          <Spinner /> Checking on-chain registration…
        </p>
      ) : pending.data ? (
        <div className="space-y-2 text-sm text-zinc-400">
          <p>A registration transaction is awaiting signatures.</p>
          <Link
            href={routes.tx(slug, pending.data.id)}
            className="font-medium text-indigo-400 underline underline-offset-4 hover:text-indigo-300"
          >
            Review pending transaction
          </Link>
        </div>
      ) : (
        <div className="space-y-3">
          {latest && (
            <div className="space-y-1 text-sm text-zinc-400">
              <p>
                {upToDate
                  ? "On-chain registration matches this treasury."
                  : "On-chain registration is out of date (name or signers changed)."}
              </p>
              <ExplorerLink
                network={treasury.network}
                target={{ txHash: latest.tx_hash }}
                className="inline-block text-xs text-indigo-400 hover:underline"
              >
                View registration on explorer ↗
              </ExplorerLink>
            </div>
          )}
          {lookup.error && <ErrorText error={lookup.error} />}
          {canBuild && (
            <>
              {offered.blocked ? (
                <p className="text-sm text-amber-300/90">{offered.blocked}</p>
              ) : (
                <>
                  <PathPicker
                    treasury={pathTreasury}
                    kind={TxKind.Registration}
                    value={chosenPath ?? ""}
                    onChange={setPath}
                    disabled={busy}
                    nowMs={nowMs}
                  />
                  <div className="flex flex-wrap items-center gap-2">
                    <Button
                      variant="secondary"
                      loading={busy}
                      disabled={!chosenPath}
                      onClick={() =>
                        void build<BuildRegistrationResponse>("/api/tx/build-registration", {
                          treasuryId: treasury.id,
                          path: chosenPath,
                        })
                      }
                    >
                      {latest && !upToDate ? "Update registration" : latest ? "Re-register" : "Register wallet"}
                    </Button>
                    <ErrorText error={error} />
                  </div>
                </>
              )}
            </>
          )}
        </div>
      )}
    </section>
  );
}
