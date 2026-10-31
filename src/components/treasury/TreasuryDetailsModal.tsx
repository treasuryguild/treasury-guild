"use client";

// Everything about a treasury wallet that the card does not show: the full
// address, payment / stake / DRep native scripts as JSON and CBOR, CIP-1854
// metadata for SDK wallets, script hashes, and the signers in script order.
import { useId, type ReactNode } from "react";
import { apiFetch } from "@/lib/api/client";
import type { TreasuryDetailsResponse, TreasuryNativeScriptView } from "@/lib/api/types";
import { templateLabel } from "@/lib/cardano/spendingPaths";
import { describeThreshold } from "@/lib/cardano/thresholds";
import { networkName } from "@/lib/config";
import { formatDate, shortAddress } from "@/lib/format";
import { routes } from "@/lib/routes";
import { useAsyncData } from "@/hooks/useAsyncData";
import { RegisterTreasury } from "@/components/treasury/RegisterTreasury";
import { Button, CopyButton, ErrorText, ExplorerLink, LinkButton, Modal, Spinner } from "@/components/ui";

export function TreasuryDetailsModal({
  treasuryId,
  treasuryName,
  slug,
  communityId,
  onClose,
}: {
  treasuryId: string;
  treasuryName: string;
  /** Community slug for staking / Cardano gov links and registration builds. */
  slug?: string;
  /** Needed for the CIP-0146 registration card (treasury-actor gate). */
  communityId?: string;
  onClose: () => void;
}) {
  const titleId = useId();
  const details = useAsyncData(treasuryId, () =>
    apiFetch<TreasuryDetailsResponse>("/api/treasury", { query: { treasuryId } }),
  );
  const t = details.data?.treasury ?? null;
  const paymentJson = t ? JSON.stringify(t.nativeScript, null, 2) : "";
  const metadataJson = t?.cip1854Metadata ? JSON.stringify(t.cip1854Metadata, null, 2) : "";

  return (
    <Modal
      open
      onClose={onClose}
      labelledBy={titleId}
      scroll
      className="w-[calc(100vw-2rem)] sm:max-w-2xl"
    >
      <div className="mb-4 flex items-start justify-between gap-3">
        <h2 id={titleId} className="min-w-0 break-words text-lg font-medium">
          {treasuryName}
        </h2>
        <Button variant="secondary" onClick={onClose}>
          Close
        </Button>
      </div>

      {details.loading && (
        <p role="status" className="flex items-center gap-2 text-sm text-zinc-400">
          <Spinner /> Loading wallet details…
        </p>
      )}
      <ErrorText error={details.error} />
      {details.error && (
        <Button variant="secondary" className="mt-2" onClick={details.reload}>
          Retry
        </Button>
      )}

      {t && (
        <div className="space-y-5 text-sm">
          <dl className="grid gap-3 sm:grid-cols-[max-content_1fr] sm:gap-x-6">
            <Row label="Address">
              <Hex value={t.address} />
              <ExplorerLink network={t.network} target={{ address: t.address }}
                className="mt-1 inline-block text-xs text-indigo-400 hover:underline">
                View on explorer ↗
              </ExplorerLink>
            </Row>
            <Row label="Network">{networkName(t.network)}</Row>
            <Row label="Template">{templateLabel(t.template)}</Row>
            <Row label={t.template === "plain" ? "Signing rule" : "Base rule"}>
              {describeThreshold(t.scriptType, t.required, t.signers.filter((s) => s.group === "base").length)}{" "}
              <span className="text-zinc-500">({t.scriptType})</span>
            </Row>
            {t.recovery && (
              <Row label="Recovery rule">
                {describeThreshold(t.recovery.scriptType, t.recovery.required, t.signers.filter((s) => s.group === "recovery").length)}{" "}
                <span className="text-zinc-500">({t.recovery.scriptType})</span>
              </Row>
            )}
            {t.lockUntil && (
              <Row label={t.template === "lock_until" ? "Locked until" : "Recovery from"}>
                {formatDate(t.lockUntil, "datetime")} <span className="text-zinc-500">(slot {t.lockSlot})</span>
              </Row>
            )}
            {t.cosigner && (
              <Row label="Co-signer">
                {t.cosigner.kind === "app" ? "Treasury Guild (app-held key)" : "A member"}{" "}
                <span className="font-mono text-xs text-zinc-500">{shortAddress(t.cosigner.walletAddress)}</span>
              </Row>
            )}
            <Row label="Script hash" hint="Also the policy id of tokens minted without a time lock.">
              <Hex value={t.scriptHash} />
            </Row>
            {t.sdk && <Row label="Wallet kind">SDK (staking and Cardano governance)</Row>}
            {t.stakeAddress && (
              <Row label="Stake address">
                <Hex value={t.stakeAddress} />
              </Row>
            )}
            {t.stakeCredentialHash && (
              <Row label="Stake credential">
                <Hex value={t.stakeCredentialHash} />
              </Row>
            )}
            {t.dRepId && (
              <Row label="DRep id">
                <Hex value={t.dRepId} />
              </Row>
            )}
          </dl>
          {slug && t.canStake && (
            <div className="flex flex-wrap gap-2">
              <LinkButton href={routes.treasuryStaking(slug, treasuryId)} variant="secondary">
                Staking
              </LinkButton>
              {t.canDrep && (
                <LinkButton href={routes.treasuryCardanoGov(slug, treasuryId)} variant="secondary">
                  Cardano governance
                </LinkButton>
              )}
            </div>
          )}

          {slug && communityId && (
            <RegisterTreasury treasury={t} slug={slug} communityId={communityId} />
          )}

          <section>
            <SectionLabel>Signers ({t.signers.length}, in script order)</SectionLabel>
            <ol className="space-y-2">
              {t.signers.map((s, i) => (
                <li key={s.keyHash} className="rounded-xl bg-zinc-800/60 px-3 py-2">
                  <p className="flex flex-wrap items-center gap-x-2">
                    <span className="text-zinc-500">{i + 1}.</span>
                    <span className="font-medium">{s.displayName || shortAddress(s.walletAddress)}</span>
                    {s.group !== "base" && (
                      <span className="text-xs text-zinc-500">{s.group === "recovery" ? "recovery" : "co-signer"}</span>
                    )}
                    {s.displayName && (
                      <span className="font-mono text-xs text-zinc-500">
                        {shortAddress(s.walletAddress)}
                      </span>
                    )}
                    <CopyButton value={s.walletAddress} />
                  </p>
                  <p className="mt-1 flex items-center gap-1.5 font-mono text-xs text-zinc-500">
                    <span className="break-all">key hash {s.keyHash}</span>
                    <CopyButton value={s.keyHash} label="Copy key hash" />
                  </p>
                  {s.stakeKeyHash && (
                    <p className="mt-1 flex items-center gap-1.5 font-mono text-xs text-zinc-500">
                      <span className="break-all">stake key hash {s.stakeKeyHash}</span>
                      <CopyButton value={s.stakeKeyHash} label="Copy stake key hash" />
                    </p>
                  )}
                  {s.drepKeyHash && (
                    <p className="mt-1 flex items-center gap-1.5 font-mono text-xs text-zinc-500">
                      <span className="break-all">DRep key hash {s.drepKeyHash}</span>
                      <CopyButton value={s.drepKeyHash} label="Copy DRep key hash" />
                    </p>
                  )}
                </li>
              ))}
            </ol>
          </section>

          {metadataJson && (
            <ScriptJsonSection
              title="CIP-1854 metadata"
              json={metadataJson}
              copyLabel="Copy CIP-1854 metadata"
            />
          )}

          <ScriptJsonSection
            title="Payment native script (JSON)"
            json={paymentJson}
            copyLabel="Copy payment native script JSON"
          />
          <ScriptCborSection
            title="Payment native script (CBOR hex)"
            cbor={t.scriptCbor}
            copyLabel="Copy payment script CBOR"
          />

          {t.stakeScript && (
            <NativeScriptBlocks
              label="Stake"
              view={t.stakeScript}
              hashLabel="Stake script hash"
            />
          )}

          {t.drepScript && (
            <>
              {t.drepScript.paymentFallback && (
                <p className="text-xs text-zinc-500">
                  No dedicated DRep keys: the payment script is used as the DRep.
                </p>
              )}
              <NativeScriptBlocks
                label="DRep"
                view={t.drepScript}
                hashLabel="DRep script hash"
              />
            </>
          )}
        </div>
      )}
    </Modal>
  );
}

function NativeScriptBlocks({
  label,
  view,
  hashLabel,
}: {
  label: string;
  view: TreasuryNativeScriptView;
  hashLabel: string;
}) {
  const json = JSON.stringify(view.nativeScript, null, 2);
  return (
    <>
      <RowBlock label={hashLabel}>
        <Hex value={view.scriptHash} />
      </RowBlock>
      <ScriptJsonSection
        title={`${label} native script (JSON)`}
        json={json}
        copyLabel={`Copy ${label.toLowerCase()} native script JSON`}
      />
      <ScriptCborSection
        title={`${label} native script (CBOR hex)`}
        cbor={view.scriptCbor}
        copyLabel={`Copy ${label.toLowerCase()} script CBOR`}
      />
    </>
  );
}

function ScriptJsonSection({
  title,
  json,
  copyLabel,
}: {
  title: string;
  json: string;
  copyLabel: string;
}) {
  return (
    <section>
      <SectionLabel action={<CopyButton value={json} label={copyLabel} />}>
        {title}
      </SectionLabel>
      <pre className="whitespace-pre-wrap break-all rounded-lg bg-zinc-950 p-3 font-mono text-xs text-zinc-300">
        {json}
      </pre>
    </section>
  );
}

function ScriptCborSection({
  title,
  cbor,
  copyLabel,
}: {
  title: string;
  cbor: string;
  copyLabel: string;
}) {
  return (
    <section>
      <SectionLabel action={<CopyButton value={cbor} label={copyLabel} />}>
        {title}
      </SectionLabel>
      <pre className="whitespace-pre-wrap break-all rounded-lg bg-zinc-950 p-3 font-mono text-xs text-zinc-300">
        {cbor}
      </pre>
    </section>
  );
}

function RowBlock({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section>
      <SectionLabel>{label}</SectionLabel>
      <div className="min-w-0">{children}</div>
    </section>
  );
}

function Row({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: string;
  children: ReactNode;
}) {
  return (
    <>
      <dt className="text-zinc-400" title={hint}>
        {label}
      </dt>
      <dd className="min-w-0">
        {children}
        {hint && <p className="mt-0.5 text-xs text-zinc-500">{hint}</p>}
      </dd>
    </>
  );
}

/** A copyable hex/bech32 value that wraps instead of overflowing. */
function Hex({ value }: { value: string }) {
  return (
    <span className="flex items-start gap-1.5">
      <span className="min-w-0 break-all font-mono text-xs">{value}</span>
      <CopyButton value={value} label={`Copy ${value.slice(0, 8)}…`} className="mt-0.5" />
    </span>
  );
}

function SectionLabel({ children, action }: { children: ReactNode; action?: ReactNode }) {
  return (
    <h3 className="mb-2 flex items-center justify-between gap-2 text-sm font-medium text-zinc-400">
      <span>{children}</span>
      {action}
    </h3>
  );
}
