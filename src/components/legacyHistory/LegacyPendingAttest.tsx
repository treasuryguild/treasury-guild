"use client";

import type { LegacyAttestKind } from "@/lib/legacyHistory/attestation";
import { useLegacyImportAttest } from "@/hooks/useLegacyImportAttest";
import { Button, ErrorText } from "@/components/ui";

export function LegacyPendingAttest({
  communityId,
  communitySlug,
  legacyWalletId,
  walletAddress,
  importId,
  planHash,
  kind,
  signatures,
  required,
  onDone,
}: {
  communityId: string;
  communitySlug: string;
  legacyWalletId: string;
  walletAddress: string;
  importId: string;
  planHash: string;
  kind: LegacyAttestKind;
  signatures: number;
  required: number;
  onDone: () => void;
}) {
  const host = typeof window !== "undefined" ? window.location.host : "localhost";
  const { attest, busy, error, blockedReason } = useLegacyImportAttest({
    communityId, communitySlug, legacyWalletId, walletAddress, host,
  });

  return (
    <div className="space-y-3 rounded-lg border border-amber-700/50 bg-amber-950/20 p-4">
      <p className="text-sm text-zinc-200">
        This import is staged on the server. Sign with the previous wallet&apos;s key
        {required > 1 ? ` (${signatures}/${required} base signers)` : ""} to activate it on the Dashboard.
      </p>
      {blockedReason && <p className="text-sm text-zinc-400">{blockedReason}</p>}
      <ErrorText error={error} />
      <Button
        loading={busy}
        disabled={!!blockedReason}
        onClick={() => void attest(kind, importId, planHash).then((r) => { if (r?.state === "active") onDone(); })}
      >
        Sign ownership
      </Button>
    </div>
  );
}
